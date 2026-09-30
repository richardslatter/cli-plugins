"""Private stdin/stdout bridge. Never expose this protocol as a network API."""
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/github-cli'))
from core import Fault, GitHub, execute, SCHEMAS
from login import Login
from security import require_memory_filesystem

GH = os.environ.get('GH_BINARY', '/usr/local/bin/gh')
NTN = os.environ.get('NTN_BINARY', '/usr/local/bin/ntn')
RAM = Path(os.environ.get('CLI_TEMP_DIR', '/dev/shm/cli-plugins'))
ALLOWED_GITHUB = {x.casefold() for x in os.environ.get('GITHUB_ALLOWED_LOGINS', '').split(',') if x}
JOBS = {}
LOCK = threading.RLock()
WRITE_LOCK = threading.Lock()


class LoginStore:
    def __init__(self): self.result = None
    def save(self, owner, subject, account, token):
        if account['login'].casefold() not in ALLOWED_GITHUB:
            raise Fault('account_mismatch', 'Sign in with an allowed GitHub account. No credential was saved.')
        self.result = {'key': str(account['id']), 'profile': {'name': account['login']},
                       'session': {'token': token, 'identity': account}}


def notion_env(directory, token=None, workspace=None):
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(directory),
           'NOTION_HOME': str(directory), 'XDG_CONFIG_HOME': str(directory),
           'XDG_CACHE_HOME': str(directory), 'NOTION_KEYRING': '0',
           'NOTION_ENV': 'prod', 'NOTION_API_VERSION': '2026-03-11', 'TERM': 'dumb'}
    if token: env['NOTION_API_TOKEN'] = token
    if workspace: env['NOTION_WORKSPACE_ID'] = workspace
    return env


def ntn(args, directory, token=None, workspace=None, timeout=45):
    import selectors
    import signal
    p = subprocess.Popen([NTN, *args], cwd=directory, env=notion_env(directory, token, workspace),
                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         start_new_session=True)
    chunks = {p.stdout: bytearray(), p.stderr: bytearray()}
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as sel:
            for stream in chunks: sel.register(stream, selectors.EVENT_READ)
            while sel.get_map():
                if time.monotonic() > deadline: raise Fault('timeout', 'Notion CLI timed out. Reconnect or narrow the request.')
                for key, _ in sel.select(.1):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data: sel.unregister(key.fileobj); continue
                    chunks[key.fileobj].extend(data)
                    if sum(map(len, chunks.values())) > 2 * 1024 * 1024:
                        raise Fault('output_limit', 'Notion response is too large. Use a smaller page size.')
        p.wait(timeout=max(.1, deadline-time.monotonic()))
        return p.returncode, bytes(chunks[p.stdout]), bytes(chunks[p.stderr])
    finally:
        if p.poll() is None: os.killpg(p.pid, signal.SIGKILL); p.wait()
        p.stdout.close(); p.stderr.close()


def json_result(code, out):
    if code: raise Fault('notion_request_failed', 'Notion declined the request. Check access or reconnect the workspace.')
    try: return json.loads(out)
    except ValueError: raise Fault('invalid_response', 'The CLI returned an unreadable response.')


def notion_finish(job):
    directory = job['directory']
    try:
        code, _, _ = ntn(['login', 'poll'], directory, timeout=600)
        if code: raise Fault('login_failed', 'Notion login expired or was declined. Start a new connection.')
        code, token_bytes, _ = ntn(['auth', 'token', '--plain'], directory)
        token = token_bytes.decode().strip()
        if code or not re.fullmatch(r'[A-Za-z0-9_.-]{20,4096}', token):
            raise Fault('invalid_login', 'Notion did not return a usable CLI credential.')
        config = json.loads((directory/'config.json').read_text())
        defaults = config.get('defaultWorkspaceIds', {})
        workspace = defaults.get('prod') if isinstance(defaults, dict) else None
        if not isinstance(workspace, str) or not UUID.fullmatch(workspace):
            raise Fault('invalid_workspace', 'The CLI did not identify the connected workspace.')
        code, out, _ = ntn(['whoami', '--json'], directory, token, workspace)
        user = json_result(code, out)
        uid = user.get('id')
        if not isinstance(uid, str) or not UUID.fullmatch(uid): raise Fault('invalid_login', 'Notion did not identify the user.')
        bot = user.get('bot', {})
        workspace_name = bot.get('workspace_name') or workspace
        # PATs represent a person; bot tokens include their owner separately.
        person = user if user.get('type') == 'person' else bot.get('owner', {}).get('user', user)
        profile = {'name': f"{person.get('name') or user.get('name') or 'Notion'} · {workspace_name}"}
        if person.get('person', {}).get('email'): profile['email'] = person['person']['email']
        with LOCK:
            job['result'] = {'key': workspace+':'+uid, 'profile': profile,
                             'session': {'token': token, 'workspace': workspace, 'identity': uid}}
            job['state'] = 'connected'
    except Fault as e:
        with LOCK: job.update(state='failed', error=e.data)
    except Exception:
        with LOCK: job.update(state='failed', error={'code':'login_failed', 'message':'Notion login could not finish. Start again.'})
    finally: shutil.rmtree(directory, ignore_errors=True)


UUID = re.compile(r'(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})')


def login_start(app, flow):
    key = app+':'+flow
    with LOCK:
        now=time.time()
        for old, j in list(JOBS.items()):
            if j.get('expires', 0)<now and j.get('state')!='pending': JOBS.pop(old, None)
        if key in JOBS: return login_status(app, flow)
        if sum(j.get('state')=='pending' for j in JOBS.values()) >= 2:
            raise Fault('busy', 'Two sign-ins are already pending. Finish one before starting another.')
        if app=='github-cli':
            store=LoginStore();login=Login(GH, RAM, store)
            j={'state':'pending','login':login,'store':store,'expires':now+900}
            JOBS[key]=j;login.start('browser',flow)
            return {'phase':'waiting'}
        if app!='notion-cli': raise Fault('invalid_app','Unknown login provider.')
        directory=Path(tempfile.mkdtemp(prefix='notion-login-',dir=RAM))
        code,out,err=ntn(['login','--no-browser'],directory)
        text=(out+err).decode('utf-8','replace')
        # Only a documented public approval URL and short comparison code reach the browser.
        url=re.search(r'https://app\.notion\.com/workers/cli-login\?verificationCode=([A-Z0-9]{3}-[A-Z0-9]{3})(?![A-Z0-9])',text)
        if code or not url:
            shutil.rmtree(directory,ignore_errors=True)
            raise Fault('login_failed','Notion did not return a valid browser sign-in page.')
        j={'state':'pending','directory':directory,'userCode':url.group(1),'verificationUrl':url.group(0),'expires':now+900}
        JOBS[key]=j
        threading.Thread(target=notion_finish,args=(j,),daemon=True).start()
        return {'phase':'waiting','userCode':j['userCode'],'verificationUrl':j['verificationUrl']}


def login_status(app, flow):
    with LOCK:
        j=JOBS.get(app+':'+flow)
        if not j: raise Fault('login_expired','Start a new connection.')
        if app=='github-cli':
            status=j['login'].status('browser',flow)
            j['state']=status['state']
            if j['state']=='connected': j['result']=j['store'].result
            if status.get('error'): j['error']=status['error']
            j['userCode']=status.get('user_code');j['verificationUrl']=status.get('verification_url')
        if j['state']=='failed': raise Fault(**j['error'])
        if j['state']=='connected':
            result=j['result'];JOBS.pop(app+':'+flow,None)
            return {'phase':'complete',**result}
        return {'phase':'waiting','userCode':j.get('userCode'),'verificationUrl':j.get('verificationUrl'),'retryAfterMs':5000}


def notion_read(session, operation, args):
    # Validate again in the native boundary; arbitrary API paths or methods are never accepted.
    schemas = {
        'account': set(), 'search': {'query','page_size','start_cursor'},
        'read_page': {'page_id'}, 'page_metadata': {'page_id'},
        'block_children': {'block_id','page_size','start_cursor'},
        'database': {'database_id'}, 'data_source': {'data_source_id'},
        'query_data_source': {'data_source_id','page_size','start_cursor'},
    }
    if operation not in schemas or set(args)-schemas[operation]: raise Fault('invalid_input','Unknown Notion operation or input.')
    for k,v in args.items():
        if k.endswith('_id') and (not isinstance(v,str) or not UUID.fullmatch(v)): raise Fault('invalid_input','Use a Notion UUID.')
        if k=='page_size' and (type(v)!=int or not 1<=v<=100): raise Fault('invalid_input','Page size must be 1–100.')
        if k=='start_cursor' and (not isinstance(v,str) or len(v)>200 or any(ord(c)<32 for c in v)): raise Fault('invalid_input','Invalid cursor.')
        if k=='query' and (not isinstance(v,str) or len(v)>200): raise Fault('invalid_input','Search query is too long.')
    if operation=='account': command=['whoami','--json']
    elif operation=='read_page': command=['pages','get',args['page_id'],'--json']
    else:
        path={'page_metadata':lambda:'v1/pages/'+args['page_id'],
              'block_children':lambda:'v1/blocks/'+args['block_id']+'/children',
              'database':lambda:'v1/databases/'+args['database_id'],
              'data_source':lambda:'v1/data_sources/'+args['data_source_id'],
              'query_data_source':lambda:'v1/data_sources/'+args['data_source_id']+'/query',
              'search':lambda:'v1/search'}[operation]()
        command=['api',path,'-X','POST' if operation in ('search','query_data_source') else 'GET','--notion-version','2026-03-11']
        paging={k:args[k] for k in ('page_size','start_cursor') if k in args and args[k]!=''}
        if operation=='search' and args.get('query'): paging['query']=args['query']
        if operation in ('search','query_data_source'): command+=['--data',json.dumps(paging)]
        else: command+=[k+'=='+str(v) for k,v in paging.items()]
    with tempfile.TemporaryDirectory(prefix='notion-read-',dir=RAM) as d:
        code,out,_=ntn(command,d,session['token'],session['workspace'])
        return json_result(code,out)


def dispatch(message):
    action=message['action'];app=message.get('app')
    if action=='probe':
        with tempfile.TemporaryDirectory(prefix='probe-',dir=RAM) as d:
            g,gh,_=execute(GH,['--version'],d)
            n,notion,_=ntn(['--version'],d)
            if g or n or not gh.startswith(b'gh version 2.101.0 ') or b'0.23.13' not in notion:
                raise Fault('native_unavailable','The pinned native CLIs are unavailable.')
            return {'github':'2.101.0','notion':'0.23.13','credentials':'memory-only scratch'}
    if action=='login_start': return login_start(app,message['flow'])
    if action=='login_status': return login_status(app,message['flow'])
    if action!='read': raise Fault('unknown_action','Unsupported native action.')
    session=message['session'];op=message['operation'];args=message['arguments']
    if app=='github-cli':
        gh=GitHub(GH,RAM,session['token']);who=gh.run('account',{})
        if who['id']!=session['identity']['id'] or who['login'].casefold() not in ALLOWED_GITHUB:
            raise Fault('account_mismatch','The GitHub session belongs to a different account.')
        return who if op=='account' else gh.run(op,args)
    if app=='notion-cli': return notion_read(session,op,args)
    raise Fault('invalid_app','Unsupported native provider.')


def reply(message):
    try:
        result=dispatch(message)
        data={'id':message['id'],'ok':True,'result':result}
        if len(json.dumps(data).encode())>150000: raise Fault('output_limit','Result is too large. Narrow the request.')
    except Fault as e: data={'id':message.get('id'),'ok':False,'error':e.data}
    except Exception: data={'id':message.get('id'),'ok':False,'error':{'code':'request_failed','message':'The native request could not finish.'}}
    with WRITE_LOCK: print(json.dumps(data),flush=True)


if __name__=='__main__':
    os.umask(0o077)
    if os.environ.get('NODE_ENV')=='production': require_memory_filesystem(RAM)
    else: RAM.mkdir(parents=True,exist_ok=True,mode=0o700)
    for old in RAM.iterdir():
        if old.is_dir() and old.name.startswith(('request-','login-','notion-','probe-')):
            shutil.rmtree(old)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        try:
            for line in sys.stdin:
                if len(line)>262144: break
                message=json.loads(line);pool.submit(reply,message)
        finally:
            for job in JOBS.values():
                if job.get('login'): job['login'].cancel()
