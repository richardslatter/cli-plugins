import { spawn } from 'node:child_process';

export const CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264';
const audiences = { skype: 'https://api.spaces.skype.com', chatsvcagg: 'https://chatsvcagg.teams.microsoft.com' };
export class SafeError extends Error { constructor(code, message) { super(message); this.code = code; } }
export function readAccounts(raw) {
  const accounts = JSON.parse(raw || '[]');
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 20) throw new Error('ALLOWED_ACCOUNTS_JSON must contain the allowed account profiles.');
  for (const p of accounts) if (!/^[a-z0-9-]{1,64}$/.test(p.id) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.tenantId) || typeof p.loginHint !== 'string' || !p.loginHint.includes('@') || typeof p.name !== 'string') throw new Error('Invalid account profile configuration.');
  if (new Set(accounts.map(p=>p.id)).size !== accounts.length) throw new Error('Duplicate account profile IDs.');
  return accounts;
}
export function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
  catch { throw new SafeError('invalid_token', 'Microsoft returned an unreadable token.'); }
}
export function validateBundle(tokens, profile) {
  const rows = Object.entries(audiences).map(([kind,aud]) => {
    const c = tokenClaims(tokens[kind]);
    if (c.aud !== aud || c.tid?.toLowerCase() !== profile.tenantId.toLowerCase() || !c.oid) throw new SafeError('wrong_account', 'The sign-in did not match the selected organisation.');
    if (!Number.isFinite(c.exp) || c.exp <= Date.now()/1000 + 30) throw new SafeError('login_required', 'Sign in to Teams again.');
    return c;
  });
  if (rows[0].oid !== rows[1].oid) throw new SafeError('mixed_credentials', 'The returned credentials do not belong to the same user.');
  const hint = profile.loginHint.toLowerCase(), guest = hint.replace('@','_') + '#ext#@';
  if (!rows.some(c=>[c.email,c.upn,c.unique_name,c.preferred_username].some(s=>typeof s==='string' && (s.toLowerCase()===hint || s.toLowerCase()===`live.com#${hint}` || s.toLowerCase().startsWith(guest))))) throw new SafeError('wrong_account', 'That Microsoft account is not allowed for this connection.');
  return { oid: rows[0].oid, expiresAt: Math.min(...rows.map(c=>c.exp))*1000 };
}
export async function microsoft(profile, endpoint, parameters, fetcher = fetch) {
  let response;
  try { response = await fetcher(`https://login.microsoftonline.com/${profile.tenantId}/oauth2/${endpoint}`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:CLIENT_ID,...parameters}), redirect:'error', signal:AbortSignal.timeout(20000) }); }
  catch { throw new SafeError('microsoft_unavailable', 'Microsoft sign-in is temporarily unavailable. Try again.'); }
  const data = await response.json();
  if (!response.ok && !data.error) throw new SafeError('microsoft_unavailable','Microsoft sign-in is temporarily unavailable.');
  return data;
}
export function denied(data) {
  const n = Number.isInteger(data.error_codes?.[0]) ? ` (AADSTS${data.error_codes[0]})` : '';
  return new SafeError('login_required', `Microsoft declined this sign-in${n}. Sign in again or review the organisation's policy.`);
}
export async function startDevice(profile) {
  const d = await microsoft(profile,'devicecode',{resource:audiences.skype});
  if (d.error) throw denied(d);
  let u; try { u=new URL(d.verification_uri || d.verification_url); } catch { throw new SafeError('invalid_login','Microsoft returned an invalid sign-in address.'); }
  if (u.protocol!=='https:' || u.username || u.password || !['microsoft.com','www.microsoft.com','login.microsoft.com','login.microsoftonline.com'].includes(u.hostname) || !/^[A-Z0-9-]{6,20}$/i.test(d.user_code) || typeof d.device_code!=='string') throw new SafeError('invalid_login','Microsoft returned an invalid sign-in response.');
  return { code:d.device_code, userCode:d.user_code, verificationUrl:u.href, expiresAt:Date.now()+Math.min(Number(d.expires_in)||900,900)*1000, interval:Math.max(5,Number(d.interval)||5)*1000, nextPollAt:Date.now()+5000 };
}
export async function finishGrant(profile, granted) {
  if (granted.error) throw denied(granted);
  if (!granted.refresh_token || !granted.access_token) throw new SafeError('missing_token','Microsoft did not return a complete Teams session.');
  const csa = await microsoft(profile,'token',{grant_type:'refresh_token',refresh_token:granted.refresh_token,resource:audiences.chatsvcagg});
  if (csa.error) throw denied(csa);
  const tokens = {skype:granted.access_token,chatsvcagg:csa.access_token};
  return {tokens,refreshToken:csa.refresh_token||granted.refresh_token,...validateBundle(tokens,profile)};
}
export async function pollDevice(profile, device) {
  if (Date.now()>=device.expiresAt) throw new SafeError('login_expired','This sign-in expired. Start a new connection.');
  if (Date.now()<device.nextPollAt) return null;
  device.nextPollAt=Date.now()+device.interval;
  const r=await microsoft(profile,'token',{grant_type:'urn:ietf:params:oauth:grant-type:device_code',code:device.code});
  if (r.error==='authorization_pending') return null;
  if (r.error==='slow_down') { device.interval+=5000;device.nextPollAt=Date.now()+device.interval;return null; }
  return finishGrant(profile,r);
}
export async function refreshSession(profile, session) {
  if (session.expiresAt>Date.now()+60000) { validateBundle(session.tokens,profile); return session; }
  const grant=await microsoft(profile,'token',{grant_type:'refresh_token',refresh_token:session.refreshToken,resource:audiences.skype});
  if (!grant.refresh_token && !grant.error) grant.refresh_token=session.refreshToken;
  return {...session,...await finishGrant(profile,grant)};
}
export function runReader(binary, profile, tokens, command, args) {
  // Fixed executable and arguments. Tokens enter the child through stdin only.
  if (!['chats','messages'].includes(command)) throw new SafeError('invalid_command','Only chat reads are supported.');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['--credentials-stdin','--tenant',profile.tenantId,'--command',command,...args],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8'}});
    let output='',length=0,finished=false;
    const fail=()=>{if(finished)return;finished=true;clearTimeout(timer);child.kill('SIGKILL');reject(new SafeError('teams_read_failed','The Teams reader could not complete this request. Try again or reconnect the account.'));};
    const timer=setTimeout(fail,60000);
    child.on('error',fail);child.stdin.on('error',()=>{});child.stderr.resume();
    child.stdout.on('data',chunk=>{length+=chunk.length;if(length>8*1024*1024)fail();else output+=chunk.toString();});
    child.on('close',code=>{if(finished)return;if(code!==0){fail();return;}try{const data=JSON.parse(output);finished=true;clearTimeout(timer);resolve(data);}catch{fail();}});
    child.stdin.end(JSON.stringify({account:profile.id,tenantId:profile.tenantId,tokens}));
  });
}
