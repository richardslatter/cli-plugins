import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from app import create_app, redact
from core import Directory, Fault, GitHub, Repo, Revision, Search, TextFile, Page, execute, error_response, parse_response, safe_env
from security import Store, verify_request, require_memory_filesystem

OWNER='owner@example.test';SUBJECT='verified-site-subject';KEY=b'k'*32

@pytest.fixture
def store(tmp_path):return Store(tmp_path/'durable'/'db.sqlite',KEY)

def signed(data,nonce=None,stamp=None):
    body=json.dumps(data).encode();nonce=nonce or os.urandom(16).hex();stamp=str(stamp or int(time.time()))
    mac=hmac.new(KEY,f'{stamp}\n{nonce}\nPOST\n/rpc\n{hashlib.sha256(body).hexdigest()}'.encode(),hashlib.sha256).hexdigest()
    return body,{'x-bridge-time':stamp,'x-bridge-nonce':nonce,'x-bridge-signature':mac,'content-type':'application/json'}

def request_data(op='status',args=None,owner=OWNER,subject=SUBJECT):return dict(owner=owner,subject=subject,operation=op,arguments=args or {})

def test_encrypted_restart_isolation_and_deletion(store,tmp_path):
    token='gho_'+'testsecret'*5;account={'id':'123','login':'rick-colosl'}
    store.save(OWNER,SUBJECT,account,token)
    assert token.encode() not in Path(store.path).read_bytes()
    code='from security import Store;import sys;s=Store(sys.argv[1],b"k"*32);assert s.token("owner@example.test","verified-site-subject")=="gho_"+"testsecret"*5;print("new process decrypted fixture")'
    assert subprocess.run([sys.executable,'-c',code,store.path],cwd=Path(__file__).parent,capture_output=True,check=True).stdout.strip()==b'new process decrypted fixture'
    with pytest.raises(Fault,match='wrong_owner'):store.token(OWNER,'other-subject')
    with pytest.raises(Fault,match='credential_unavailable'):Store(store.path,b'x'*32).token(OWNER,SUBJECT)
    store.disconnect(OWNER,SUBJECT)
    with pytest.raises(Fault,match='not_connected'):store.token(OWNER,SUBJECT)
    assert store.identity(OWNER,SUBJECT)['id']=='123'
    with pytest.raises(Fault,match='account_mismatch'):store.save(OWNER,SUBJECT,{'id':'456','login':'rick-colosl'},token)
    with pytest.raises(Fault,match='account_mismatch'):store.save(OWNER,SUBJECT,{'id':'123','login':'other'},token)

def test_signature_replay_expiry_owner_and_tampering(store):
    body,headers=signed(request_data());assert verify_request(body,headers,KEY,store,OWNER)['subject']==SUBJECT
    with pytest.raises(Fault,match='request_replayed'):verify_request(body,headers,KEY,store,OWNER)
    with pytest.raises(Fault,match='unauthorized'):verify_request(body+b' ',headers,KEY,store,OWNER)
    body,h=signed(request_data(),stamp=int(time.time())-61)
    with pytest.raises(Fault,match='unauthorized'):verify_request(body,h,KEY,store,OWNER)
    body,h=signed(request_data(owner='intruder@example.test'))
    with pytest.raises(Fault,match='wrong_owner'):verify_request(body,h,KEY,store,OWNER)

@pytest.mark.parametrize('model,args',[
 (Repo,{'repository':'-R/--help'}),(Repo,{'repository':'x/..'}),(Repo,{'repository':'https://evil.test/x'}),
 (Revision,{'repository':'owner/repo','ref':'--help'}),(Revision,{'repository':'owner/repo','ref':'main?x=1'}),
 (Directory,{'repository':'owner/repo','ref':'main','path':'../secret'}),
 (Directory,{'repository':'owner/repo','ref':'main','path':'/etc/passwd'}),
 (Page,{'page':True}),(Page,{'per_page':101}),(Page,{'page':'1'}),(Page,{'owner':'spoof'}),
 (Search,{'query':'hello repo:other/private','repository':'owner/repo'}),
 (Search,{'query':'hello OR world','organisation':'owner'}),
])
def test_reject_argument_injection(model,args):
    with pytest.raises(ValidationError):model(**args)

def test_api_forces_get_and_omits_inherited_secrets(monkeypatch,tmp_path):
    monkeypatch.setenv('GITHUB_TOKEN','unrelated');monkeypatch.setenv('GH_HOST','evil.test')
    captured=[]
    def fake(binary,args,config,token=None,timeout=25):
        captured.append(args);return 0,b'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/user/repos?page=2>; rel="next"\r\n\r\n[]',b''
    monkeypatch.setattr('core.execute',fake)
    data=GitHub('/official/gh',tmp_path,'credential').run('repositories',{})
    args=captured[0];assert args[args.index('--method')+1]=='GET';assert args[args.index('--hostname')+1]=='github.com'
    assert args[-1].startswith('user/repos?') and 'owner%2Ccollaborator%2Corganization_member' in args[-1]
    assert data['next_page']==2 and not data['complete']
    env=safe_env(tmp_path);assert 'GITHUB_TOKEN' not in env and 'GH_TOKEN' not in env and env['GH_HOST']=='github.com'

def test_repository_deduplication_and_final_page(monkeypatch,tmp_path):
    row={'id':42,'name':'one','full_name':'owner/one','owner':{'login':'owner'},'permissions':{'pull':True},'private':True,'default_branch':'main','html_url':'https://github.com/owner/one'}
    monkeypatch.setattr(GitHub,'api',lambda *a,**k:([row,row],{}))
    result=GitHub('/gh',tmp_path,'x').run('repositories',{})
    assert len(result['items'])==1 and result['complete'] and result['next_page'] is None

@pytest.mark.parametrize('status,h,body,code',[(401,{},b'','authentication_expired'),(404,{},b'','not_found_or_inaccessible'),(403,{'x-github-sso':'required'},b'','sso_required'),(403,{'x-ratelimit-remaining':'0'},b'','rate_limited'),(403,{},b'','forbidden')])
def test_structured_github_errors(status,h,body,code):assert error_response(status,h,body).data['code']==code

def test_bounded_file_and_revision(monkeypatch,tmp_path):
    def fake(self,path,params=None,**kw):
        if '/commits/' in path:return {'sha':'a'*40},{}
        assert params['ref']=='a'*40
        return {'type':'file','size':8,'encoding':'base64','content':base64.b64encode(b'a\nb\nc\nd\n').decode(),'sha':'b'*40},{}
    monkeypatch.setattr(GitHub,'api',fake)
    result=GitHub('/gh',tmp_path,'x').run('read_file',{'repository':'o/r','ref':'branch/name','path':'x.txt','start_line':2,'end_line':3})
    assert result['content']=='b\nc' and result['next_line']==4 and result['revision']=='a'*40 and '#L2-L3' in result['url']

def test_api_anonymous_wrong_owner_and_read_only(store,tmp_path):
    with TestClient(create_app(store,KEY,OWNER,temp_root=tmp_path/'ram-fixture',production=False)) as client:
        assert client.post('/rpc',json=request_data()).status_code==401
        body,h=signed(request_data(owner='intruder@example.test'));assert client.post('/rpc',content=body,headers=h).status_code==403
        for op in ['shell','push','issue_edit','api','POST','merge']:
            body,h=signed(request_data(op));r=client.post('/rpc',content=body,headers=h);assert r.json()['error']['code']=='unknown_tool'
        body,h=signed(request_data('repositories',{'page':0}));assert client.post('/rpc',content=body,headers=h).json()['error']['code']=='invalid_input'
        body,h=signed(request_data('repositories'));assert client.post('/rpc',content=body,headers=h).json()['error']['code']=='not_connected'

def test_redaction():assert 'secret' not in str(redact({'token':'gho_'+'secret'*8}))

def test_subprocess_timeout_and_output_limit(tmp_path):
    with pytest.raises(Fault,match='timeout'):execute(sys.executable,['-c','import time;time.sleep(5)'],tmp_path,timeout=.15)
    with pytest.raises(Fault,match='output_limit'):execute(sys.executable,['-c','print("x"*3000000)'],tmp_path)

def test_memory_filesystem_fails_closed(tmp_path):
    if not Path('/proc/mounts').exists():
        with pytest.raises(FileNotFoundError):require_memory_filesystem(tmp_path)
    else:
        with pytest.raises(RuntimeError):require_memory_filesystem(tmp_path)
