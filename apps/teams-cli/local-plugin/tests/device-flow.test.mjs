import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceInfo, validateBundle, completeDeviceLogin, safeMicrosoftError } from '../scripts/device-flow.mjs';
import { AUDIENCES } from '../scripts/store.mjs';

const profile = { tenantId: '11111111-1111-1111-1111-111111111111', loginHint: 'reader@example.com' };
const jwt = (kind, extra = {}) => `e30.${Buffer.from(JSON.stringify({ aud: AUDIENCES[kind], tid: profile.tenantId, oid: 'same-user', exp: Math.floor(Date.now()/1000)+3600, upn: profile.loginHint, ...extra })).toString('base64url')}.test`;
const bundle = () => ({ skype: jwt('skype'), chatsvcagg: jwt('chatsvcagg') });
const device = { verification_url: 'https://login.microsoft.com/device', device_code: 'private-device-code', user_code: 'ABCD12345', expires_in: 900, interval: 5 };

test('device metadata exposes only the intended user code and Microsoft URL', () => {
  const info = deviceInfo(device);
  assert.equal(info.userCode, device.user_code);
  assert.equal(info.device_code, undefined);
  assert.throws(() => deviceInfo({ ...device, verification_url: 'https://login.microsoft.com.evil.test/device' }), { code: 'invalid_verification_url' });
  assert.throws(() => deviceInfo({ ...device, verification_url: 'http://login.microsoft.com/device' }), { code: 'invalid_verification_url' });
});

test('account, tenant, audience and credential pairing are enforced', () => {
  assert.equal(validateBundle(bundle(), profile).length, 2);
  for (const [extra, code] of [
    [{ tid: 'other-tenant' }, 'wrong_tenant'],
    [{ aud: 'other-resource' }, 'wrong_audience'],
    [{ oid: 'different-user' }, 'mixed_credentials'],
    [{ exp: 1 }, 'login_required'],
  ]) assert.throws(() => validateBundle({ ...bundle(), skype: jwt('skype', extra) }, profile), { code });
  assert.throws(() => validateBundle({ skype: jwt('skype', { upn: 'wrong@example.com' }), chatsvcagg: jwt('chatsvcagg', { upn: 'wrong@example.com' }) }, profile), { code: 'wrong_account' });
  assert.equal(validateBundle({ skype: jwt('skype', { upn: 'reader_example.com#EXT#@guest.onmicrosoft.com' }), chatsvcagg: jwt('chatsvcagg', { upn: 'reader_example.com#EXT#@guest.onmicrosoft.com' }) }, profile).length, 2);
});

test('polling handles pending and slowdown, exchanges the second resource, and discards refresh tokens', async () => {
  let clock = 0;
  const sleeps = [], calls = [], phases = [];
  const replies = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: jwt('skype'), refresh_token: 'private-refresh' }, { access_token: jwt('chatsvcagg'), refresh_token: 'rotated-refresh' }];
  const tokens = await completeDeviceLogin(profile, device, p => phases.push(p), {
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    form: async (p, endpoint, params) => { calls.push({ endpoint, params }); return replies.shift(); },
  });
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  assert.deepEqual(phases, ['authorizing']);
  assert.equal(calls[3].params.resource, AUDIENCES.chatsvcagg);
  assert.equal(calls[3].params.refresh_token, 'private-refresh');
  assert.deepEqual(Object.keys(tokens).sort(), ['chatsvcagg', 'skype']);
});

test('expired and denied login fail without leaking Microsoft response details', async () => {
  let clock = 0;
  await assert.rejects(completeDeviceLogin(profile, { ...device, expires_in: 5 }, () => {}, {
    now: () => clock, sleep: async ms => { clock += ms; }, form: async () => ({ error: 'authorization_pending' }),
  }), { code: 'login_timeout' });
  const error = safeMicrosoftError({ error_codes: [7000218], error_description: 'SECRET_ACCESS_TOKEN' });
  assert.match(error.message, /AADSTS7000218/);
  assert.doesNotMatch(error.message, /SECRET/);
});
