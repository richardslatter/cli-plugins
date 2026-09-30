import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const origin=new URL(process.argv[2]||process.env.PUBLIC_URL||'');
if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Pass the deployed HTTPS origin.');
const output=path.resolve(process.argv[3]||path.join(root,'dist'));fs.mkdirSync(output,{recursive:true});
const apps=['teams-cli','github-cli','notion-cli'];
// A portable MCP configuration alone does not register a ChatGPT cloud app.
// Require mappings obtained from actual ChatGPT connections for cloud builds.
const mode=process.argv[4];
if(!['--cloud-apps','--portable'].includes(mode))throw new Error('Choose --cloud-apps /path/to/verified-bindings.json or --portable for desktop MCP clients.');
const bindings=mode==='--cloud-apps'?JSON.parse(fs.readFileSync(process.argv[5],'utf8')):null;
if(bindings){
  const ids=new Set();
  for(const app of apps){
    const binding=bindings[app];
    if(!binding||binding.endpoint!==new URL(`/apps/${app}/mcp`,origin).href||!/^((plugin_)?asdk_app_)[A-Za-z0-9_-]+$/.test(binding.id||''))throw new Error(`${app}: provide the verified registered app ID and exact endpoint.`);
    if(ids.has(binding.id))throw new Error('Each plugin requires a distinct registered app.');
    ids.add(binding.id);
  }
}
const health=await fetch(new URL('/healthz',origin),{signal:AbortSignal.timeout(20000)});if(!health.ok)throw new Error('Backend health check failed.');
for(const app of apps){
  const url=new URL(`/apps/${app}/mcp`,origin).href;
  const r=await fetch(new URL(`/.well-known/oauth-protected-resource/apps/${app}/mcp`,origin));
  if(!r.ok||(await r.json()).resource!==url)throw new Error(`${app} discovery failed.`);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cli-package-'));
  try{
    const d=path.join(temporary,app);fs.cpSync(path.join(root,'apps',app,'plugin'),d,{recursive:true});
    const write=(name,data)=>fs.writeFileSync(path.join(d,name),JSON.stringify(data,null,2)+'\n');
    const manifest=JSON.parse(fs.readFileSync(path.join(d,'plugin.json'),'utf8'));
    manifest.homepage=new URL(`/apps/${app}`,origin).href;
    manifest.extensions['com.openai'].interface.websiteURL=manifest.homepage;
    if(bindings){
      manifest.extensions['com.openai'].apps='./.app.json';
      manifest.extensions['com.openai'].requires_local_executor=false;
      write('.app.json',{apps:{[app]:{id:bindings[app].id,required:true}}});
      // Updating an account plugin overlays files, so explicitly replace both
      // old MCP declarations to avoid a duplicate desktop-only connection.
      write('mcp.json',{$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{}});
      write('.mcp.json',{mcpServers:{}});
    }else{
      write('mcp.json',{$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{[app]:{type:'streamable-http',url}}});
      write('.mcp.json',{mcpServers:{[app]:{type:'streamable-http',url,headers:{}}}});
    }
    write('plugin.json',manifest);
    fs.mkdirSync(path.join(d,'.codex-plugin'),{recursive:true});
    write('.codex-plugin/plugin.json',{
      name:manifest.name,version:manifest.version,description:manifest.description,
      author:manifest.author,homepage:manifest.homepage,repository:manifest.repository,
      keywords:manifest.keywords||[],skills:'./skills',mcpServers:'./.mcp.json',
      ...manifest.extensions['com.openai'],
    });
    const archive=path.join(output,`${app}.zip`);fs.rmSync(archive,{force:true});execFileSync('/usr/bin/zip',['-q','-r',archive,app],{cwd:temporary});console.log(JSON.stringify({archive,mode:bindings?'registered-cloud-app':'portable-mcp',version:manifest.version}));
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
