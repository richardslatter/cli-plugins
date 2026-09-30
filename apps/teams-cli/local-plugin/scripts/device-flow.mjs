import { CLIENT_ID, AUDIENCES, SafeError, validateToken } from './store.mjs';

export async function microsoftForm(profile, endpoint, parameters, fetcher = fetch) {
  const response = await fetcher(`https://login.microsoftonline.com/${profile.tenantId}/oauth2/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...parameters }),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok && !data.error) throw new SafeError('microsoft_unavailable', 'Microsoft sign-in is temporarily unavailable.');
  return data;
}
export function safeMicrosoftError(data) {
  const code = Array.isArray(data.error_codes) && Number.isInteger(data.error_codes[0]) ? ` (AADSTS${data.error_codes[0]})` : '';
  return new SafeError('microsoft_sign_in_failed', `Microsoft declined this sign-in${code}. Review the browser prompt or tenant policy.`);
}
export function deviceInfo(data) {
  const raw = data.verification_uri || data.verification_url;
  let url;
  try { url = new URL(raw); } catch { throw new SafeError('invalid_verification_url', 'Microsoft returned an unexpected sign-in address.'); }
  if (url.protocol !== 'https:' || !['microsoft.com', 'www.microsoft.com', 'login.microsoft.com', 'login.microsoftonline.com'].includes(url.hostname) || url.username || url.password) throw new SafeError('invalid_verification_url', 'Microsoft returned an unexpected sign-in address.');
  if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string' || !/^[A-Z0-9-]{6,20}$/i.test(data.user_code) || !(Number(data.expires_in)>0)) throw new SafeError('invalid_device_response', 'Microsoft did not return a valid sign-in request.');
  return { verificationUrl: url.toString(), userCode: data.user_code, expiresAt: new Date(Date.now() + Number(data.expires_in)*1000).toISOString(), interval: Math.max(5, Number(data.interval) || 5) };
}
export function validateBundle(tokens, profile) {
  const decoded = ['skype', 'chatsvcagg'].map(kind => validateToken(tokens[kind], kind, profile));
  if (!decoded[0].oid || decoded.some(c=>c.oid !== decoded[0].oid)) throw new SafeError('mixed_credentials', 'Microsoft returned credentials for different users. Sign in again.');
  const hint = profile.loginHint.toLowerCase();
  const guestHint = hint.replace('@','_') + '#ext#@';
  const matches = decoded.some(c => [c.email,c.upn,c.unique_name,c.preferred_username].filter(Boolean).some(s=>s.toLowerCase()===hint || s.toLowerCase()===`live.com#${hint}` || s.toLowerCase().startsWith(guestHint)));
  if (!matches) throw new SafeError('wrong_account', 'The signed-in account does not match the selected profile.');
  return decoded;
}
export async function completeDeviceLogin(profile, device, onPhase, { form=microsoftForm, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)), now=()=>Date.now() } = {}) {
  let interval = Math.max(5, Number(device.interval) || 5)*1000;
  const deadline = now() + Math.min(Number(device.expires_in)*1000,15*60*1000);
  let granted;
  while (now() < deadline) {
    await sleep(interval);
    granted = await form(profile, 'token', { grant_type:'urn:ietf:params:oauth:grant-type:device_code', code:device.device_code });
    if (granted.error === 'authorization_pending') continue;
    if (granted.error === 'slow_down') { interval += 5000; continue; }
    if (granted.error) throw safeMicrosoftError(granted);
    if (!granted.access_token || !granted.refresh_token) throw new SafeError('missing_token', 'Microsoft did not return the tokens needed for Teams access.');
    break;
  }
  if (!granted?.access_token) throw new SafeError('login_timeout', 'Sign-in expired. Use start_login to try again.');
  onPhase('authorizing');
  const refreshed = await form(profile, 'token', { grant_type:'refresh_token', refresh_token:granted.refresh_token, resource:AUDIENCES.chatsvcagg });
  if (refreshed.error) throw safeMicrosoftError(refreshed);
  const tokens = { skype:granted.access_token, chatsvcagg:refreshed.access_token };
  if (granted.id_token) tokens.teams=granted.id_token;
  validateBundle(tokens,profile);
  // Refresh tokens are used transiently to obtain the second resource, then discarded.
  return tokens;
}
