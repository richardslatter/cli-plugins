import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AUDIENCES, getProfile, privateDir, readJSON, writePrivate, processAlive, SafeError, errorResult } from './store.mjs';
import { microsoftForm, deviceInfo, safeMicrosoftError, completeDeviceLogin } from './device-flow.mjs';

process.umask(0o077);
const profile=getProfile(process.argv[2] || '');
privateDir(profile.dir);
const lockPath=path.join(profile.dir,'login.lock');
const previous=readJSON(lockPath);
if(previous && processAlive(previous.pid)) process.exit(0);
if(previous) fs.unlinkSync(lockPath);
try { fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600}); }
catch { process.exit(0); }
const setStatus=(phase,extra={})=>writePrivate(path.join(profile.dir,'login-status.json'),{account:profile.id,phase,pid:process.pid,updatedAt:new Date().toISOString(),...extra});
let localServer;
try {
  setStatus('starting');
  const device=await microsoftForm(profile,'devicecode',{resource:AUDIENCES.skype});
  if(device.error) throw safeMicrosoftError(device);
  const info=deviceInfo(device);
  const pageKey=randomUUID();
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let phase='waiting_for_sign_in';
  // This page displays only the short user code, never access/refresh tokens.
  localServer=http.createServer((req,res)=>{
    if(req.method!=='GET' || req.url!==`/${pageKey}` || req.headers.host!==`127.0.0.1:${localServer.address().port}`){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
    res.end(`<!doctype html><html><head><title>Teams CLI sign-in</title><meta name="viewport" content="width=device-width"></head><body style="font:18px system-ui;max-width:620px;margin:10vh auto;padding:24px;color:#17213a;background:#f4f6fb"><h1>Connect ${escape(profile.name)}</h1>${phase==='complete'?'<p>Signed in successfully. You can return to Codex.</p>':`<p>Sign in as <strong>${escape(profile.loginHint)}</strong> for ${escape(profile.tenantName)}.</p><p>Use this code on Microsoft’s sign-in page:</p><p style="font:700 36px monospace;letter-spacing:4px">${escape(info.userCode)}</p><p><a href="${escape(info.verificationUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 24px;border-radius:8px;background:#4057d6;color:white;text-decoration:none">Open Microsoft sign-in</a></p><p>Approve only the sign-in you started here. Return to Codex when Microsoft confirms it.</p>`}</body></html>`);
  });
  await new Promise(resolve=>localServer.listen(0,'127.0.0.1',resolve));
  const localUrl=`http://127.0.0.1:${localServer.address().port}/${pageKey}`;
  setStatus('waiting_for_sign_in',{...info,tenant:profile.tenantName,loginPage:localUrl});
  // macOS resolves the default browser; no Chrome dependency or UI automation.
  const opener=spawn('/usr/bin/open',[localUrl],{stdio:'ignore'}); opener.on('error',()=>{});
  const tokens=await completeDeviceLogin(profile,device,next=>{phase=next;setStatus(next,{tenant:profile.tenantName});});
  writePrivate(path.join(profile.dir,'credentials.json'),{account:profile.id,tenantId:profile.tenantId,savedAt:new Date().toISOString(),authMethod:'device-code',tokens});
  phase='complete';
  setStatus('complete',{tenant:profile.tenantName,message:'Signed in using your default browser. Chat tools are ready.'});
} catch(e) {
  const safe=e instanceof SafeError?e:new SafeError('browser_login_failed','Microsoft sign-in could not finish. Use start_login to try again.');
  setStatus('failed',errorResult(safe));process.exitCode=1;
} finally {
  localServer?.close();
  if(readJSON(lockPath)?.pid===process.pid)fs.unlinkSync(lockPath);
}
