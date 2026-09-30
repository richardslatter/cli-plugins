"""Check hosted discovery, access gates and client persistence without a browser.

Run prepare, restart the service, then run verify with the same protected state
file. This checks OAuth client persistence, not provider authentication.
"""
import argparse
import base64
import hashlib
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

APPS = ('teams-cli', 'github-cli', 'notion-cli')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(origin, path, data=None):
    req = urllib.request.Request(origin + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Accept': 'application/json', 'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as r:
        return r.code, r.headers, r.read()


def check(origin, mode, state_file):
    os.umask(0o077)
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme != 'https' or parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError('Use an HTTPS origin without a trailing slash.')
    status, _, body = request(origin, '/healthz')
    if status != 200 or not json.loads(body).get('ok'):
        raise RuntimeError('The hosted service is not healthy.')
    state = {'origin': origin, 'clients': {}} if mode == 'prepare' else json.loads(state_file.read_text())
    if state['origin'] != origin:
        raise RuntimeError('The saved state belongs to another service.')
    for app in APPS:
        base = '/apps/' + app
        scope = app.removesuffix('-cli') + '.read'
        resource = origin + base + '/mcp'
        status, _, body = request(origin, '/.well-known/oauth-protected-resource' + base + '/mcp')
        if status != 200 or json.loads(body).get('resource') != resource:
            raise RuntimeError(app + ': protected resource discovery failed.')
        status, _, body = request(origin, '/.well-known/oauth-authorization-server' + base)
        if status != 200 or json.loads(body).get('issuer') != origin + base:
            raise RuntimeError(app + ': issuer discovery failed.')
        status, headers, _ = request(origin, base + '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
        if status != 401 or 'resource_metadata=' not in headers.get('www-authenticate', ''):
            raise RuntimeError(app + ': anonymous access gate failed.')
        if mode == 'prepare':
            status, _, body = request(origin, base + '/register', {
                'client_name': 'CLI Plugins deployment check',
                'redirect_uris': ['http://127.0.0.1:52731/callback'],
                'token_endpoint_auth_method': 'none',
                'grant_types': ['authorization_code', 'refresh_token'],
                'response_types': ['code'],
            })
            if status != 201:
                raise RuntimeError(app + ': client registration failed.')
            state['clients'][app] = json.loads(body)['client_id']
        challenge = base64.urlsafe_b64encode(hashlib.sha256(secrets.token_bytes(32)).digest()).decode().rstrip('=')
        query = urllib.parse.urlencode({
            'client_id': state['clients'][app], 'redirect_uri': 'http://127.0.0.1:52731/callback',
            'response_type': 'code', 'scope': scope, 'resource': resource,
            'code_challenge': challenge, 'code_challenge_method': 'S256',
        })
        status, headers, _ = request(origin, base + '/authorize?' + query)
        if status != 302 or not headers.get('location', '').startswith(base + '/connect/'):
            raise RuntimeError(app + ': saved client authorization failed.')
        print(json.dumps({'app': app, 'discovery': 'passed', 'anonymousAccess': 'blocked',
                          'savedClient': 'accepted', 'mode': mode}))
    if mode == 'prepare':
        state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        state_file.write_text(json.dumps(state))
        state_file.chmod(0o600)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--origin', required=True)
    p.add_argument('--mode', required=True, choices=['prepare', 'verify'])
    p.add_argument('--state-file', required=True, type=Path)
    args = p.parse_args()
    check(args.origin, args.mode, args.state_file)
