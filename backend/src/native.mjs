import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { SafeError } from '../../apps/teams-cli/teams.mjs';

export class Native {
  constructor(root, env=process.env) {
    this.pending=new Map();
    this.child=spawn(env.PYTHON_BINARY||'/opt/venv/bin/python',[`${root}/backend/native.py`],{cwd:root,stdio:['pipe','pipe','pipe'],env:{PATH:env.PATH,NODE_ENV:env.NODE_ENV||'production',CLI_TEMP_DIR:env.CLI_TEMP_DIR||'/dev/shm/cli-plugins',GITHUB_ALLOWED_LOGINS:env.GITHUB_ALLOWED_LOGINS||'',GH_BINARY:env.GH_BINARY||'/usr/local/bin/gh',NTN_BINARY:env.NTN_BINARY||'/usr/local/bin/ntn',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1'}});
    this.child.stderr.resume();this.child.stdin.on('error',()=>{});
    createInterface({input:this.child.stdout}).on('line',line=>{
      if(Buffer.byteLength(line)>200000){this.child.kill();return;}
      try{const data=JSON.parse(line), p=this.pending.get(data.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(data.id);data.ok?p.resolve(data.result):p.reject(new SafeError(data.error?.code||'request_failed',data.error?.message||'The native request failed.'));}catch{this.child.kill();}
    });
    const fail=()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new SafeError('native_unavailable','The native service is unavailable. Try again shortly.'));}this.pending.clear();};
    this.child.on('error',fail);this.child.on('exit',fail);
  }
  call(action, data) {
    if(this.child.exitCode!==null||this.child.killed)return Promise.reject(new SafeError('native_unavailable','The native service is unavailable.'));
    if(this.pending.size>=8)return Promise.reject(new SafeError('busy','The service is busy. Retry shortly.'));
    return new Promise((resolve,reject)=>{
      const id=randomUUID(), timer=setTimeout(()=>{this.pending.delete(id);reject(new SafeError('timeout','The native request timed out.'));},70000);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,action,...data})+'\n');
    });
  }
  close(){this.child.kill('SIGTERM');}
}
