import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const origin=new URL(process.argv[2]||process.env.PUBLIC_URL||'');
if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Pass the deployed HTTPS origin.');
const output=path.resolve(process.argv[3]||path.join(root,'dist'));fs.mkdirSync(output,{recursive:true});
const health=await fetch(new URL('/healthz',origin),{signal:AbortSignal.timeout(20000)});if(!health.ok)throw new Error('Backend health check failed.');
for(const app of ['teams-cli','github-cli','notion-cli']){
  const url=new URL(`/apps/${app}/mcp`,origin).href;
  const r=await fetch(new URL(`/.well-known/oauth-protected-resource/apps/${app}/mcp`,origin));
  if(!r.ok||(await r.json()).resource!==url)throw new Error(`${app} discovery failed.`);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cli-package-'));
  try{
    const d=path.join(temporary,app);fs.cpSync(path.join(root,'apps',app,'plugin'),d,{recursive:true});
    fs.writeFileSync(path.join(d,'mcp.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{[app]:{type:'streamable-http',url}}},null,2)+'\n');
    const archive=path.join(output,`${app}.zip`);fs.rmSync(archive,{force:true});execFileSync('/usr/bin/zip',['-q','-r',archive,app],{cwd:temporary});console.log(archive);
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
