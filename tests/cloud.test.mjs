import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../backend/src/vault.mjs';
import { makeApp } from '../backend/src/server.mjs';
import { validRedirect } from '../backend/src/oauth.mjs';

function fixtures(){return ['teams-cli','github-cli','notion-cli'].map((id,i)=>({id,name:id,scope:`${id.split('-')[0]}.read`,icon:'/teams-cli.png',intro:'Fixture',provider:'Fixture',accounts:[],start:async()=>({userCode:'ABC-DEF',verificationUrl:'https://app.notion.com/workers/cli-login?verificationCode=ABC-DEF',interval:5000,code:'private-device-fixture'}),poll:async()=>({phase:'complete',key:'fixture-'+i,profile:{name:'Account '+i,email:`fixture${i}@example.test`},session:{token:'fixture-native-secret-'+i}}),tools:[{name:'read_fixture',description:'Read fixture data',schema:{},read:async stored=>({account:stored.profile.name})}]}));}
async function setup(t){
  const vault=new Vault(':memory:','ab'.repeat(32));
  const server=await new Promise(resolve=>{const s=makeApp({vault,origin:new URL('http://localhost'),adapters:fixtures()}).app.listen(0,'127.0.0.1',()=>resolve(s));});
  // Recreate routes with their real local OAuth origin after allocating a port.
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const origin=`http://localhost:${port}`;
  const {app}=makeApp({vault,origin:new URL(origin),adapters:fixtures()});
  const live=await new Promise(resolve=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>live.close(resolve));vault.close();});
  const request=(url,options)=>fetch(new URL(url,origin),options);
  return {vault,origin,request};
}
async function register(ctx,id){
  const r=await ctx.request(`/apps/${id}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Fixture ChatGPT',redirect_uris:['http://localhost/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
  assert.equal(r.status,201);return r.json();
}
async function grant(ctx,id,client){
  const verifier='a'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
  const params=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],code_challenge:challenge,code_challenge_method:'S256',state:'fixture-state',scope:`${id.split('-')[0]}.read`,resource:`${ctx.origin}/apps/${id}/mcp`});
  const r=await ctx.request(`/apps/${id}/authorize?${params}`,{redirect:'manual'});
  assert.equal(r.status,302);const location=r.headers.get('location'),cookie=r.headers.get('set-cookie').split(';')[0];
  const page=await ctx.request(location,{headers:{cookie}});assert.equal(page.status,200);
  const text=await page.text(),csrf=/data-csrf="([^"]+)"/.exec(text)[1];
  const post=async(name,data={})=>ctx.request(location+'/'+name,{method:'POST',headers:{cookie,Origin:ctx.origin,'Content-Type':'application/json'},body:JSON.stringify({csrf,...data})});
  return {location,cookie,csrf,post,verifier};
}
async function connect(ctx,id,client){
  const f=await grant(ctx,id,client);const start=await f.post('start');assert.equal(start.status,200);assert.ok(!(await start.text()).includes('private-device'));
  const poll=await f.post('poll');assert.equal(poll.status,200);const callback=new URL((await poll.json()).redirect);
  assert.equal(callback.searchParams.get('iss'),`${ctx.origin}/apps/${id}`);assert.equal(callback.searchParams.get('state'),'fixture-state');
  const code=callback.searchParams.get('code');
  const exchange=verifier=>ctx.request(`/apps/${id}/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:client.redirect_uris[0],code_verifier:verifier,resource:`${ctx.origin}/apps/${id}/mcp`})});
  return {exchange,f,code};
}
async function mcp(ctx,id,token,method,params){return ctx.request(`/apps/${id}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/json, text/event-stream','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}

test('all three endpoints advertise distinct issuers and require authentication',async t=>{
  const c=await setup(t);
  for(const id of ['teams-cli','github-cli','notion-cli']){
    const protectedResource=await c.request(`/.well-known/oauth-protected-resource/apps/${id}/mcp`);assert.equal(protectedResource.status,200);
    const p=await protectedResource.json();assert.equal(p.resource,`${c.origin}/apps/${id}/mcp`);
    const issuer=await (await c.request(`/.well-known/oauth-authorization-server/apps/${id}`)).json();assert.equal(issuer.issuer,p.authorization_servers[0]);assert.equal(issuer.authorization_endpoint,`${c.origin}/apps/${id}/authorize`);
    const denied=await c.request(`/apps/${id}/mcp`,{method:'POST'});assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate'),/resource_metadata/);
  }
});
test('PKCE is enforced, codes are single use, refresh tokens rotate and revoke',async t=>{
  const c=await setup(t),id='github-cli',client=await register(c,id),flow=await connect(c,id,client);
  assert.equal((await flow.exchange('b'.repeat(64))).status,400);
  const good=await flow.exchange(flow.f.verifier);assert.equal(good.status,200);const tokens=await good.json();
  assert.equal((await flow.exchange(flow.f.verifier)).status,400);
  const refresh=token=>c.request(`/apps/${id}/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:token})});
  const rotated=await refresh(tokens.refresh_token);assert.equal(rotated.status,200);const next=await rotated.json();assert.notEqual(next.refresh_token,tokens.refresh_token);assert.equal((await refresh(tokens.refresh_token)).status,400);
  const revoked=await c.request(`/apps/${id}/revoke`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,token:next.access_token})});assert.equal(revoked.status,200);
  assert.equal((await mcp(c,id,next.access_token,'tools/list',{})).status,401);
});
test('native profiles list the account, remain stable and isolate each plugin',async t=>{
  const c=await setup(t),id='teams-cli',client=await register(c,id),flow=await connect(c,id,client),tokens=await (await flow.exchange(flow.f.verifier)).json();
  const tools=await (await mcp(c,id,tokens.access_token,'tools/list',{})).json();assert.equal(tools.result.tools.find(t=>t.name==='get_profile')._meta['openai/profile'],true);
  const profile=await (await mcp(c,id,tokens.access_token,'tools/call',{name:'get_profile',arguments:{}})).json();const p=profile.result.structuredContent;
  assert.equal(p.email,'fixture0@example.test');assert.deepEqual(Object.keys(p).sort(),['email','id','name']);assert.ok(!JSON.stringify(profile).includes('fixture-native-secret'));
  const other=await mcp(c,'github-cli',tokens.access_token,'tools/list',{});assert.equal(other.status,401);
  const reconnect=await connect(c,id,client),again=await (await reconnect.exchange(reconnect.f.verifier)).json();
  const againProfile=await (await mcp(c,id,again.access_token,'tools/call',{name:'get_profile',arguments:{}})).json();assert.equal(againProfile.result.structuredContent.id,p.id);
});
test('browser sessions and CSRF protect login; other clients cannot redeem a code',async t=>{
  const c=await setup(t),id='notion-cli',client=await register(c,id),f=await grant(c,id,client);
  assert.equal((await c.request(f.location)).status,400);
  const missingOrigin=await c.request(f.location+'/start',{method:'POST',headers:{cookie:f.cookie,'Content-Type':'application/json'},body:JSON.stringify({csrf:f.csrf})});assert.equal(missingOrigin.status,400);
  assert.equal((await f.post('start',{csrf:'wrong'})).status,400);
  const malicious=await c.request(`/apps/${id}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:['https://example.test/callback'],token_endpoint_auth_method:'none'})});assert.equal(malicious.status,400);
  const flow=await connect(c,id,client),other=await register(c,id);
  const exchange=await c.request(`/apps/${id}/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:other.client_id,code:flow.code,code_verifier:flow.f.verifier,redirect_uri:other.redirect_uris[0]})});assert.equal(exchange.status,400);
});
test('encrypted credentials survive reopening; authenticated record keys reject tampering',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cli-vault-test-')),file=path.join(directory,'vault.sqlite'),key='cd'.repeat(32);
  try{let v=new Vault(file,key);v.set('teams:credential',{secret:'fixture-persistence-secret'});v.close();assert.ok(!fs.readFileSync(file).includes(Buffer.from('fixture-persistence-secret')));v=new Vault(file,key);assert.equal(v.get('teams:credential').secret,'fixture-persistence-secret');
    v.db.prepare('INSERT INTO vault(key,value,expires) SELECT ?,value,expires FROM vault WHERE key=?').run('github:credential','teams:credential');assert.throws(()=>v.get('github:credential'));v.close();
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('redirect restrictions reject lookalike domains and fragments',()=>{assert.ok(validRedirect('https://chatgpt.com/connector_platform_oauth_redirect'));assert.ok(validRedirect('https://chatgpt.com/connector/oauth/fixture-id'));assert.ok(!validRedirect('https://chatgpt.com.evil.test/connector_platform_oauth_redirect'));assert.ok(!validRedirect('https://chatgpt.com/connector_platform_oauth_redirect#x'));});
