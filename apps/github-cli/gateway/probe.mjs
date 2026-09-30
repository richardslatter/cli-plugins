import { spawnSync } from 'node:child_process';

export async function probe() {
  const result = { timestamp: new Date().toISOString(), purpose: 'Production Sites runtime capability probe. No GitHub authentication.', native_gh: null, https: [] };
  try {
    const p = spawnSync('gh', ['--version'], { timeout: 2000, maxBuffer: 4096, shell: false });
    result.native_gh = { supported: !p.error && p.status === 0, exit_code: p.status, error: p.error?.message ?? null, version: p.status === 0 ? String(p.stdout).slice(0,500) : null };
  } catch (e) { result.native_gh = { supported: false, error: String(e.message).slice(0,500) }; }
  for (const url of ['https://api.github.com/meta', 'https://github.com/login/device']) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'github-cli-sites-runtime-probe' }, redirect: 'manual', signal: AbortSignal.timeout(8000) }); result.https.push({ url, status: r.status, reachable: true }); await r.body?.cancel(); }
    catch (e) { result.https.push({ url, reachable: false, error: String(e.message).slice(0,200) }); }
  }
  return result;
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET') return Response.json({error:'method_not_allowed'}, {status:405});
    if (path === '/probe') return Response.json(await probe(), {headers:{'Cache-Control':'no-store'}});
    if (path === '/health') return Response.json({status:'probe_only',github_authenticated:false});
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GitHub CLI · Runtime check</title><style>body{font:16px/1.6 system-ui;background:#10151c;color:#e9edf3;max-width:760px;margin:8vh auto;padding:24px}a{color:#8dc8ff}pre{white-space:pre-wrap}h1{font-size:32px}</style><h1>GitHub CLI</h1><p>Production runtime check in progress. GitHub is not connected.</p><p>This private Site tests native process support before any GitHub authorisation. It is not yet a working GitHub plugin.</p><p><a href="/probe">Run production capability check</a></p></html>', {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"}});
  }
};
