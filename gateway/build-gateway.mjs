import { build } from './tools/node_modules/esbuild/lib/main.js';
import { writeFileSync,mkdirSync } from 'node:fs';
mkdirSync('dist/server',{recursive:true});
await build({entryPoints:['gateway.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/server/index.js',nodePaths:['./tools/node_modules'],external:['node:child_process','node:async_hooks'],loader:{'.html':'text','.txt':'text'},conditions:['workerd','worker','browser']});
writeFileSync('dist/server/wrangler.json',JSON.stringify({name:'github-cli-gateway',main:'index.js',compatibility_date:'2026-09-30',compatibility_flags:['nodejs_compat','enable_nodejs_child_process_module']}));
