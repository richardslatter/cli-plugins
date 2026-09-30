import { randomUUID } from 'node:crypto';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { randomToken, digest } from './vault.mjs';

export function validRedirect(raw, allowLoopback = false) {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.hash) return false;
    if (u.protocol==='https:' && u.hostname==='chatgpt.com' && !u.port) return u.pathname==='/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname);
    return allowLoopback && u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  } catch { return false; }
}

export function createProvider(vault, issuer, { appId, name, scope, allowLoopback = true } = {}) {
  const resource = new URL(issuer.pathname+'/mcp', issuer).href;
  const checkResource = target => { if (target && target.href !== resource) throw new InvalidTargetError('The resource must be the selected MCP endpoint.'); };
  const checkScopes = scopes => { if (scopes?.some(s=>s!==scope)) throw new InvalidScopeError('Only this plugin’s read scope is supported.'); };
  const issue = (clientId, profileKey) => {
    const access=randomToken(), refresh=randomToken(), expiresAt=Math.floor(Date.now()/1000)+3600;
    vault.set(`access:${digest(access)}`,{clientId,profileKey,expiresAt},3600);
    vault.set(`refresh:${digest(refresh)}`,{clientId,profileKey},30*24*3600);
    return {access_token:access,refresh_token:refresh,expires_in:3600,token_type:'Bearer',scope};
  };
  const grant = (client, code) => {
    const g=vault.get(`code:${digest(code)}`);
    if (!g || g.clientId!==client.client_id) throw new InvalidGrantError('This authorization code is invalid or expired.');
    return g;
  };
  return {
    clientsStore: {
      getClient: id => vault.get(`client:${id}`) || undefined,
      registerClient: async client => {
        if (!client.redirect_uris?.length || client.redirect_uris.some(uri=>!validRedirect(uri,allowLoopback))) throw new InvalidClientMetadataError('Use a ChatGPT callback or a local Codex callback.');
        const registered={...client,client_id:client.client_id||randomUUID(),client_id_issued_at:Math.floor(Date.now()/1000)};
        vault.set(`client:${registered.client_id}`,registered);
        return registered;
      },
    },
    authorize: async (client, params, res) => {
      checkResource(params.resource);checkScopes(params.scopes);
      const id=randomToken(), browser=randomToken();
      vault.set(`flow:${id}`,{clientId:client.client_id,clientName:client.client_name||'MCP client',redirectUri:params.redirectUri,state:params.state,codeChallenge:params.codeChallenge,resource,csrf:randomToken(),browserHash:digest(browser),expiresAt:Date.now()+15*60*1000,phase:'select'},900);
      res.cookie(`cli_${appId}_${id.slice(0,12)}`,browser,{httpOnly:true,secure:issuer.protocol==='https:',sameSite:'lax',maxAge:900000,path:`${issuer.pathname}/connect/${id}`});
      res.redirect(`${issuer.pathname}/connect/${id}`);
    },
    challengeForAuthorizationCode: async (client,code) => grant(client,code).codeChallenge,
    exchangeAuthorizationCode: async (client,code,_verifier,redirectUri,target) => {
      checkResource(target);
      const g=grant(client,code);
      if (!redirectUri || redirectUri!==g.redirectUri) throw new InvalidGrantError('The redirect URI does not match.');
      vault.delete(`code:${digest(code)}`);
      return issue(client.client_id,g.profileKey);
    },
    exchangeRefreshToken: async (client,token,scopes,target) => {
      checkResource(target);checkScopes(scopes);
      const key=`refresh:${digest(token)}`,g=vault.get(key);
      if (!g || g.clientId!==client.client_id || !vault.get(`profile:${g.profileKey}`)) throw new InvalidGrantError('Reconnect this account.');
      vault.delete(key);
      return issue(client.client_id,g.profileKey);
    },
    verifyAccessToken: async token => {
      const g=vault.get(`access:${digest(token)}`);
      if (!g || !vault.get(`profile:${g.profileKey}`)) throw new InvalidTokenError('Connect an account.');
      return {token,clientId:g.clientId,scopes:[scope],expiresAt:g.expiresAt,resource:new URL(resource),extra:{profileKey:g.profileKey}};
    },
    revokeToken: async (client,{token}) => {
      for (const prefix of ['access','refresh']) {const key=`${prefix}:${digest(token)}`,g=vault.get(key);if(g?.clientId===client.client_id)vault.delete(key);}
    },
    complete(flow, profileKey) {
      const code=randomToken();
      vault.set(`code:${digest(code)}`,{clientId:flow.clientId,redirectUri:flow.redirectUri,codeChallenge:flow.codeChallenge,profileKey},300);
      const callback=new URL(flow.redirectUri);callback.searchParams.set('code',code);callback.searchParams.set('iss',issuer.href);
      if(flow.state)callback.searchParams.set('state',flow.state);
      return callback.href;
    },
  };
}
