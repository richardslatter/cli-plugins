import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DATA_ROOT = path.resolve(process.env.FOSS_TEAMS_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'foss-teams'));
// Microsoft's Teams desktop/mobile public client; the web client needs a secret
// for device-code token exchange and cannot be used here.
export const CLIENT_ID = '1fec8e78-bce4-4aaf-ab1b-5451cc387264';
export const AUDIENCES = { teams: CLIENT_ID, skype: 'https://api.spaces.skype.com', chatsvcagg: 'https://chatsvcagg.teams.microsoft.com' };
export const REQUIRED_TOKENS = ['skype', 'chatsvcagg'];
export class SafeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function privateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); return dir; }
export function writePrivate(file, value) {
  privateDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}
export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new SafeError('invalid_local_config', 'A local profile file is invalid.'); }
}
export function profiles() {
  const data = readJSON(path.join(DATA_ROOT, 'accounts.json'), { accounts: [] });
  if (!Array.isArray(data.accounts)) throw new SafeError('invalid_local_config', 'Account configuration is invalid.');
  return data.accounts;
}
export function getProfile(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new SafeError('unknown_account', 'Use an account ID returned by list_accounts.');
  const profile = profiles().find(p => p.id === id);
  if (!profile || !/^[0-9a-f-]{36}$/i.test(profile.tenantId) || !profile.loginHint) throw new SafeError('unknown_account', 'Use an account ID returned by list_accounts.');
  return { ...profile, dir: path.join(DATA_ROOT, 'profiles', id) };
}
export function claims(token) {
  try {
    const pieces = token.split('.');
    if (pieces.length !== 3) throw new Error();
    return JSON.parse(Buffer.from(pieces[1], 'base64url').toString());
  } catch { throw new SafeError('invalid_token', 'Microsoft did not return a readable Teams token.'); }
}
export function validateToken(token, kind, profile, nonce) {
  const c = claims(token);
  if (c.aud !== AUDIENCES[kind]) throw new SafeError('wrong_audience', 'The token targets a different application.');
  if (c.tid?.toLowerCase() !== profile.tenantId.toLowerCase()) throw new SafeError('wrong_tenant', 'Sign-in returned a different organisation.');
  if (!Number.isFinite(c.exp) || c.exp <= Date.now() / 1000 + 30) throw new SafeError('login_required', 'The Teams session has expired. Use start_login.');
  if (kind === 'teams' && nonce !== undefined && c.nonce !== nonce) throw new SafeError('wrong_nonce', 'The sign-in response did not match this login attempt.');
  // Claims are checked here; Microsoft validates the access tokens on API calls.
  return c;
}
export function authStatus(profile) {
  const data = readJSON(path.join(profile.dir, 'credentials.json'));
  if (!data) return { authenticated: false, reason: 'login_required' };
  try {
    const decoded = REQUIRED_TOKENS.map(k => validateToken(data.tokens?.[k], k, profile));
    const subjects = new Set(decoded.map(c => c.oid).filter(Boolean));
    if (subjects.size !== 1 || decoded.some(c => !c.oid)) throw new SafeError('mixed_credentials', 'Account credentials do not match. Sign in again.');
    return { authenticated: true, tenant: profile.tenantName, method: data.authMethod || 'imported', expiresAt: new Date(Math.min(...decoded.map(c => c.exp)) * 1000).toISOString() };
  } catch (e) { return { authenticated: false, reason: e instanceof SafeError ? e.code : 'invalid_token' }; }
}
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function loginStatus(profile) {
  const status = readJSON(path.join(profile.dir, 'login-status.json'));
  if (!status) return { phase: 'idle' };
  if (['starting', 'waiting_for_sign_in', 'authorizing'].includes(status.phase) && !processAlive(status.pid)) return { phase: 'interrupted', message: 'The sign-in process ended. Use start_login to try again.' };
  const { pid, ...safe } = status;
  return safe;
}
export function errorResult(error) {
  return { error: error instanceof SafeError ? error.code : 'local_error', message: error instanceof SafeError ? error.message : 'The local operation failed. Check account status or sign in again.' };
}
