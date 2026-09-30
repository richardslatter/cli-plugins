import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { Vault, scopedVault, digest } from './vault.mjs';
import { createProvider } from './oauth.mjs';
import { Native } from './native.mjs';
import { SafeError } from '../../apps/teams-cli/teams.mjs';
import { teamsAdapter } from '../../apps/teams-cli/adapter.mjs';
import { githubAdapter } from '../../apps/github-cli/adapter.mjs';
import { notionAdapter } from '../../apps/notion-cli/adapter.mjs';
import { page, connectPage, escape } from './views.mjs';

export const root=fileURLToPath(new URL('../../',import.meta.url));
export function makeApp({vault,origin,adapters,allowLoopback=true,healthy=()=>true}) {
  const app=express(), providers=new Map(), locks=new Map();
  app.disable('x-powered-by');app.set('trust proxy',1);
  const locked=async(key,fn)=>{
    const prior=locks.get(key)||Promise.resolve(), next=prior.catch(()=>{}).then(fn);locks.set(key,next);
    try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}
  };
  app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});if(origin.protocol==='https:')res.set('Strict-Transport-Security','max-age=31536000');next();});
  app.use(express.json({limit:'128kb'}));
  app.use(express.static(path.join(root,'public'),{dotfiles:'deny',index:false}));
  app.get('/healthz',(_req,res)=>res.status(healthy()?200:503).json({ok:healthy(),service:'cli-plugins',version:'0.2.0',apps:adapters.map(a=>a.id)}));
  app.get('/',(_req,res)=>res.type('html').send(page(`<section><h2>Connect from ChatGPT</h2><p>Install each plugin separately and connect its accounts from ChatGPT’s plugin settings.</p>${adapters.map(a=>`<p><a href="/apps/${a.id}">${escape(a.name)}</a> — ${escape(a.intro)}</p>`).join('')}</section><footer>Read-only tools</footer>`)));
  for(const adapter of adapters) {
    const base=`/apps/${adapter.id}`, issuer=new URL(base,origin), resource=new URL(`${base}/mcp`,origin), metadataUrl=getOAuthProtectedResourceMetadataUrl(resource);
    const store=scopedVault(vault,adapter.id), provider=createProvider(store,issuer,{appId:adapter.id,name:adapter.name,scope:adapter.scope,allowLoopback});providers.set(adapter.id,provider);
    // Distinct issuers and resources prevent a credential for one plugin from
    // being used at another plugin's endpoint on the shared host.
    const metadata={...createOAuthMetadata({provider,issuerUrl:issuer,resourceServerUrl:resource,scopesSupported:[adapter.scope]}),authorization_endpoint:new URL(`${base}/authorize`,origin).href,token_endpoint:new URL(`${base}/token`,origin).href,registration_endpoint:new URL(`${base}/register`,origin).href,revocation_endpoint:new URL(`${base}/revoke`,origin).href,authorization_response_iss_parameter_supported:true};
    app.get([`/.well-known/oauth-authorization-server${base}`,`${base}/.well-known/oauth-authorization-server`],(_req,res)=>res.json(metadata));
    app.get(new URL(metadataUrl).pathname,(_req,res)=>res.json({resource:resource.href,authorization_servers:[issuer.href],scopes_supported:[adapter.scope],resource_name:adapter.name}));
    app.use(`${base}/authorize`,authorizationHandler({provider}));
    app.use(`${base}/token`,tokenHandler({provider}));
    app.use(`${base}/register`,clientRegistrationHandler({clientsStore:provider.clientsStore}));
    app.use(`${base}/revoke`,revocationHandler({provider}));
    app.get(base,(_req,res)=>res.type('html').send(page('<section><h2>Connect your accounts in ChatGPT</h2><p>Install this plugin, then choose “Connect another account” in its settings. Your connected accounts will appear there after sign-in.</p></section>',adapter)));
    app.use(`${base}/connect`,rateLimit({windowMs:900000,max:250,standardHeaders:true,legacyHeaders:false}));
    function flowFor(req) {
      const id=req.params.id;
      if(!/^[A-Za-z0-9_-]{43}$/.test(id))throw new SafeError('invalid_flow','Start a new connection from ChatGPT.');
      const f=store.get(`flow:${id}`),cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));
      if(!f||f.expiresAt<=Date.now()||digest(cookies[`cli_${adapter.id}_${id.slice(0,12)}`]||'')!==f.browserHash)throw new SafeError('invalid_flow','Start a new connection from ChatGPT in this browser.');
      if(req.method==='POST'&&(req.get('origin')!==origin.origin||req.body?.csrf!==f.csrf))throw new SafeError('invalid_flow','The sign-in request did not match this browser session.');
      return f;
    }
    app.get(`${base}/connect/:id`,(req,res,next)=>{try{res.type('html').send(connectPage(flowFor(req),req.params.id,adapter));}catch(e){next(e);}});
    const browserResult=f=>({phase:f.phase,...(f.redirect?{redirect:f.redirect}:{userCode:f.device?.userCode,verificationUrl:f.device?.verificationUrl,retryAfterMs:f.device?.interval||5000})});
    app.post(`${base}/connect/:id/start`,async(req,res,next)=>{try{
      const data=await locked(`${adapter.id}:flow:${req.params.id}`,async()=>{
        const f=flowFor(req),account=adapter.accounts.find(a=>a.id===req.body.account);
        if(adapter.accounts.length&&!account)throw new SafeError('unknown_account','Choose one of the listed accounts.');
        if(f.phase!=='select')throw new SafeError('already_started','This sign-in already started. Start a new connection to try again.');
        f.device=await adapter.start(account,req.params.id);f.account=account?.id;f.phase='waiting';store.set(`flow:${req.params.id}`,f,Math.ceil((f.expiresAt-Date.now())/1000));
        return browserResult(f);
      });res.json(data);
    }catch(e){next(e);}});
    app.post(`${base}/connect/:id/poll`,async(req,res,next)=>{try{
      const data=await locked(`${adapter.id}:flow:${req.params.id}`,async()=>{
        const f=flowFor(req);
        if(f.phase==='complete')return browserResult(f);
        if(f.phase!=='waiting')throw new SafeError('invalid_flow','Start a new connection.');
        const result=await adapter.poll(adapter.accounts.find(a=>a.id===f.account),f.device,req.params.id);
        if(result.phase==='complete') {
          const old=store.get(`profile:${result.key}`);
          if(old?.session.oid&&old.session.oid!==result.session.oid)throw new SafeError('wrong_account','This Teams profile belongs to a different Microsoft user.');
          store.set(`profile:${result.key}`,{key:result.key,profile:{...result.profile,id:old?.profile.id||randomUUID()},session:result.session,connectedAt:new Date().toISOString()});
          f.redirect=provider.complete(f,result.key);f.phase='complete';delete f.device;
        }else if(result.userCode){f.device.userCode=result.userCode;f.device.verificationUrl=result.verificationUrl;}
        store.set(`flow:${req.params.id}`,f,Math.ceil((f.expiresAt-Date.now())/1000));return browserResult(f);
      });res.json(data);
    }catch(e){next(e);}});
    const authenticated=requireBearerAuth({verifier:provider,requiredScopes:[adapter.scope],resourceMetadataUrl:metadataUrl});
    const output=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
    const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
    app.all(`${base}/mcp`,authenticated,async(req,res,next)=>{
      if(req.method!=='POST'){res.status(405).set('Allow','POST').end();return;}
      const key=req.auth.extra.profileKey,stored=store.get(`profile:${key}`);
      if(!stored){res.status(401).end();return;}
      const server=new McpServer({name:adapter.name,version:'0.2.0'});
      const invoke=fn=>async args=>{try{return output(await fn(args));}catch(e){const safe=e instanceof SafeError?e:new SafeError('request_failed','The request could not finish. Try again.');return {isError:true,...output({error:safe.code,message:safe.message}),...(['login_required','authentication_expired'].includes(safe.code)?{_meta:{'mcp/www_authenticate':[`Bearer error="invalid_token", resource_metadata="${metadataUrl}"`]}}:{})};}};
      server.registerTool('get_profile',{description:'Identify the single account represented by this authenticated connection.',inputSchema:{},annotations,_meta:{'openai/profile':true}},invoke(async()=>stored.profile));
      server.registerTool('account_status',{description:'Check this connection and its connected account. Other accounts are listed separately in ChatGPT plugin settings.',inputSchema:{},annotations},invoke(async()=>({profile:stored.profile,connectedAt:stored.connectedAt,readOnly:true})));
      for(const tool of adapter.tools)server.registerTool(tool.name,{description:tool.description,inputSchema:tool.schema,annotations},invoke(args=>locked(`${adapter.id}:profile:${key}`,async()=>{
        const latest=store.get(`profile:${key}`);
        latest.saveSession=async session=>{latest.session=session;const {saveSession,...saved}=latest;store.set(`profile:${key}`,saved);};
        return {result:await tool.read(latest,args),contentIsUntrusted:true};
      })));
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on('close',()=>{transport.close().catch(()=>{});server.close().catch(()=>{});});
      try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}catch(e){next(e);}
    });
  }
  app.use((err,_req,res,_next)=>{if(res.headersSent)return;const safe=err instanceof SafeError?err:new SafeError('request_failed','The request could not finish. Try again.');res.status(err instanceof SafeError?400:500).json({error:safe.code,message:safe.message});});
  return {app,providers};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  process.umask(0o077);
  let native;
  try {
    const origin=new URL(process.env.PUBLIC_URL||'');
    if(origin.protocol!=='https:'&&!(process.env.NODE_ENV==='development'&&['127.0.0.1','localhost'].includes(origin.hostname)))throw new Error('Use HTTPS.');
    if(origin.pathname!=='/'||origin.search||origin.hash)throw new Error('PUBLIC_URL must be an origin.');
    const vault=new Vault(path.join(process.env.DATA_DIR||'/var/data','cli-plugins.sqlite'),process.env.TOKEN_ENCRYPTION_KEY);
    native=new Native(root);
    await native.call('probe',{});
    const adapters=[teamsAdapter(root,process.env.TEAMS_ACCOUNTS_JSON),githubAdapter(native),notionAdapter(native)];
    const {app}=makeApp({vault,origin,adapters,healthy:()=>native.child.exitCode===null&&!native.child.killed});
    const clean=setInterval(()=>vault.clean(),60000);clean.unref();
    const server=app.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('CLI Plugins backend ready.'));
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{native.close();server.close(()=>{vault.close();process.exit(0);});setTimeout(()=>process.exit(0),10000).unref();});
  }catch{native?.close();console.error('CLI Plugins cannot start: verify the pinned CLIs, PUBLIC_URL, DATA_DIR, TOKEN_ENCRYPTION_KEY and TEAMS_ACCOUNTS_JSON.');process.exitCode=1;}
}
