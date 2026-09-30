import json
import os
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from pydantic import ValidationError
from core import Fault, GitHub, SCHEMAS, execute, GH_VERSION
from login import Login
from security import Store, key_from_file, require_memory_filesystem, verify_request

def redact(value):
    if isinstance(value,str):return re.sub(r'(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})','[REDACTED]',value)
    if isinstance(value,list):return [redact(v) for v in value]
    if isinstance(value,dict):return {k:redact(v) for k,v in value.items()}
    return value

def create_app(store=None,bridge_key=None,owner=None,binary=None,temp_root=None,production=True):
    state={}
    @asynccontextmanager
    async def lifespan(app):
        os.umask(0o077)
        root=Path(temp_root or '/dev/shm/github-cli')
        if production:require_memory_filesystem(root)
        else:root.mkdir(parents=True,exist_ok=True)
        for child in root.iterdir():
            if child.is_dir() and child.name.startswith(('request-','login-')):shutil.rmtree(child)
        state['binary']=binary or '/usr/local/bin/gh';state['root']=root
        state['owner']=owner or os.environ['OWNER_EMAIL']
        state['bridge']=bridge_key or key_from_file(os.environ['BRIDGE_KEY_FILE'])
        state['store']=store or Store(os.environ.get('DATABASE_PATH','/var/data/github-cli.sqlite'),key_from_file(os.environ['CREDENTIAL_KEY_FILE']))
        if production:
            code,out,_=execute(state['binary'],['--version'],str(root))
            if code or not out.startswith(('gh version '+GH_VERSION+' ').encode()):raise RuntimeError('Pinned official gh version is not available')
        state['login']=Login(state['binary'],root,state['store'])
        yield
        state['login'].cancel()
    app=FastAPI(lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
    @app.get('/health')
    def health():return {'service':'github-cli-native','ready':bool(state),'gh_version':GH_VERSION,'github_authentication':'not_disclosed'}
    def dispatch(data):
        owner=data['owner'];subject=data['subject'];op=data['operation'];args=data['arguments'];store=state['store']
        if not isinstance(args,dict):raise Fault('invalid_input','Arguments must be an object.')
        if op in ('status','connect','login_status','disconnect'):
            if args:raise Fault('invalid_input','Connection actions do not accept identity or other arguments.')
            if op=='status':return {'account':store.identity(owner,subject),'login':state['login'].status(owner,subject),'native_gh_version':GH_VERSION,'read_only_enforced':True}
            if op=='connect':return state['login'].start(owner,subject)
            if op=='login_status':return state['login'].status(owner,subject)
            state['login'].cancel();store.disconnect(owner,subject)
            return {'connected':False,'saved_credential_deleted':True,'github_grant_revoked':False,'backup_copies_may_remain':True}
        if op not in SCHEMAS:raise Fault('unknown_tool','Only reviewed read-only operations are allowed.')
        SCHEMAS[op][0].model_validate(args)
        token=store.token(owner,subject);gh=GitHub(state['binary'],state['root'],token)
        account=gh.run('account',{});identity=store.identity(owner,subject)
        if account['id']!=identity['id'] or account['login'].casefold()!='rick-colosl':raise Fault('account_mismatch','Saved GitHub identity does not match the required account.')
        return account if op=='account' else gh.run(op,args)
    @app.post('/rpc')
    async def rpc(request:Request):
        try:
            body=bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body)>32768:raise Fault('invalid_input','Request exceeds the 32 KiB limit.')
            data=verify_request(bytes(body),request.headers,state['bridge'],state['store'],state['owner'])
            result=redact(await run_in_threadpool(dispatch,data))
            if len(json.dumps(result).encode())>150000:raise Fault('output_limit','Result exceeds the tool output limit. Reduce per_page or the line range.')
            return JSONResponse({'ok':True,'result':result},headers={'Cache-Control':'no-store'})
        except Fault as e:
            status=401 if e.data['code']=='unauthorized' else 403 if e.data['code'] in ('wrong_owner','request_replayed') else 400
            return JSONResponse({'ok':False,'error':e.data},status_code=status,headers={'Cache-Control':'no-store'})
        except ValidationError:
            return JSONResponse({'ok':False,'error':{'code':'invalid_input','message':'Inputs do not match the tool schema.'}},status_code=400)
        except Exception:
            return JSONResponse({'ok':False,'error':{'code':'backend_failure','message':'Backend could not complete the request; inspect redacted service diagnostics.'}},status_code=503)
    return app

app=create_app()
