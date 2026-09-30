import importlib.util
import json
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location('native',Path(__file__).parents[1]/'backend/native.py')
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
UUID='01234567-89ab-cdef-0123-456789abcdef'

@pytest.fixture
def calls(tmp_path,monkeypatch):
    monkeypatch.setattr(native,'RAM',tmp_path)
    captured=[]
    def fixture(args,directory,token=None,workspace=None,timeout=45):
        captured.append((args,token,workspace))
        return 0,json.dumps({'fixture':True}).encode(),b''
    monkeypatch.setattr(native,'ntn',fixture)
    return captured

@pytest.mark.parametrize('operation,args,method,path',[
    ('search',{'query':'hello:=true @/tmp/file','page_size':10},'POST','v1/search'),
    ('query_data_source',{'data_source_id':UUID,'page_size':20},'POST',f'v1/data_sources/{UUID}/query'),
    ('block_children',{'block_id':UUID,'start_cursor':'abc'},'GET',f'v1/blocks/{UUID}/children'),
    ('page_metadata',{'page_id':UUID},'GET',f'v1/pages/{UUID}'),
])
def test_notion_fixed_read_requests(calls,operation,args,method,path):
    native.notion_read({'token':'fixture-secret','workspace':UUID},operation,args)
    command,token,workspace=calls[-1]
    assert command[:4]==['api',path,'-X',method]
    assert token=='fixture-secret' and workspace==UUID
    if operation=='search': assert json.loads(command[-1])['query']==args['query']
    assert '--unsafe-verbose' not in command

@pytest.mark.parametrize('operation,args',[
    ('delete',{'page_id':UUID}),('search',{'method':'PATCH'}),
    ('page_metadata',{'page_id':'../x'}),('block_children',{'block_id':'--verbose'}),
    ('search',{'page_size':True}),('search',{'page_size':101}),
])
def test_notion_mutations_and_injection_rejected(calls,operation,args):
    with pytest.raises(native.Fault):native.notion_read({'token':'fixture','workspace':UUID},operation,args)
    assert calls==[]

def test_native_login_rejects_unapproved_github_account(monkeypatch):
    monkeypatch.setattr(native,'ALLOWED_GITHUB',{'required-user'})
    store=native.LoginStore()
    with pytest.raises(native.Fault):store.save('unused','unused',{'id':'123','login':'wrong'},'fixture')
    assert store.result is None
    store.save('unused','unused',{'id':'123','login':'required-user'},'fixture')
    assert store.result['profile']['name']=='required-user'

def test_notion_environment_does_not_inherit_hosts_or_tokens():
    env=native.notion_env('/ram','fixture',UUID)
    assert 'NOTION_API_BASE_URL' not in env and 'NOTION_BASE_URL' not in env
    assert env['NOTION_KEYRING']=='0' and env['NOTION_HOME']=='/ram'
    assert env['NOTION_API_VERSION']=='2026-03-11'
