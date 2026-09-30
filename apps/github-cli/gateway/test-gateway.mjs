import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from './dist/server/index.js';
const env={OWNER_EMAIL:'owner@example.test'};
const owner={'oai-authenticated-user-email':env.OWNER_EMAIL,'oai-authenticated-user-id':'subject'};
function req(method,params,headers={}){return new Request('https://private.example.test/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}
test('SDK initialization and stateless discovery',async()=>{
  let r=await gateway.fetch(req('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}),env);
  assert.equal(r.status,200);let j=await r.json();assert.equal(j.result.serverInfo.name,'github-cli');
  r=await gateway.fetch(req('tools/list',{}),env);j=await r.json();assert.equal(j.result.tools.length,19);
  assert(j.result.tools.every(t=>t.annotations.readOnlyHint===true));
  assert(!j.result.tools.some(t=>['connect','disconnect','shell'].includes(t.name)));
});
test('anonymous and wrong owner denied at endpoint',async()=>{
  for(const h of [{},{'oai-authenticated-user-email':'other@example.test','oai-authenticated-user-id':'subject'}]){
    const r=await gateway.fetch(req('tools/call',{name:'repositories',arguments:{}},h),env);assert.equal(r.status,401);
  }
});
test('no backend produces explicit error, never a fabricated repository list',async()=>{
  const r=await gateway.fetch(req('tools/call',{name:'repositories',arguments:{}},owner),env);const j=await r.json();
  assert.equal(j.result.isError,true);assert.equal(j.result.structuredContent.error.code,'backend_not_configured');
});
test('unknown operations and identity arguments rejected',async()=>{
  for(const [name,args,code] of [['shell',{},'unknown_tool'],['connection_status',{owner:'spoof'},'invalid_input']]){
    const r=await gateway.fetch(req('tools/call',{name,arguments:args},owner),env);assert.equal((await r.json()).result.structuredContent.error.code,code);
  }
});
test('connection mutations require owner and same-origin action header',async()=>{
  for(const headers of [{},owner,{...owner,Origin:'https://evil.example.test','X-Github-CLI-Action':'1'}]){
    const r=await gateway.fetch(new Request('https://private.example.test/api/connect',{method:'POST',headers}),env);assert([401,403].includes(r.status));
  }
});
test('malformed and oversized MCP requests rejected',async()=>{
  for(const body of ['{','x'.repeat(33000)]){
    const r=await gateway.fetch(new Request('https://private.example.test/mcp',{method:'POST',body}),env);assert.equal(r.status,400);
  }
});
