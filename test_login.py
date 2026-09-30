import sys,time
from pathlib import Path
from login import Login
from security import Store
from core import GitHub

def wait_for(predicate):
    until=time.monotonic()+3
    while time.monotonic()<until:
        if predicate():return
        time.sleep(.02)
    raise AssertionError('Fixture login did not complete')

def fixture_cli(tmp_path,body):
    p=tmp_path/'fixture-gh';p.write_text('#!'+sys.executable+'\n'+body);p.chmod(0o700);return p

def test_real_pty_fixture_login_encryption_and_cleanup(tmp_path,monkeypatch):
    store=Store(tmp_path/'durable'/'db',b'k'*32);ram=tmp_path/'ram-fixture';ram.mkdir()
    binary=fixture_cli(tmp_path,"import os,pathlib\nprint('! First copy your one-time code: ABCD-1234',flush=True)\nprint('Press Enter to open github.com in your browser',flush=True)\ninput()\npathlib.Path(os.environ['GH_CONFIG_DIR'],'hosts.yml').write_text('github.com:\\n  user: rick-colosl\\n  oauth_token: fixture-token\\n')\n")
    monkeypatch.setattr(GitHub,'run',lambda self,*a:{'id':'123','login':'rick-colosl'})
    login=Login(binary,ram,store);login.start('owner','subject')
    wait_for(lambda:login.status('owner','subject')['state']!='pending')
    assert login.status('owner','subject')['state']=='connected'
    wait_for(lambda:not list(ram.iterdir()))
    assert store.token('owner','subject')=='fixture-token'
    assert b'fixture-token' not in Path(store.path).read_bytes()
    assert login.status('other','subject')=={'state':'idle'}

def test_pty_fixture_wrong_github_account_never_saved(tmp_path,monkeypatch):
    store=Store(tmp_path/'db',b'k'*32);ram=tmp_path/'ram';ram.mkdir()
    binary=fixture_cli(tmp_path,"import os,pathlib\npathlib.Path(os.environ['GH_CONFIG_DIR'],'hosts.yml').write_text('github.com:\\n  user: wrong\\n  oauth_token: fixture-token\\n')\n")
    monkeypatch.setattr(GitHub,'run',lambda self,*a:{'id':'999','login':'wrong'})
    login=Login(binary,ram,store);login.start('owner','subject');wait_for(lambda:login.status('owner','subject')['state']!='pending')
    assert login.status('owner','subject')['error']['code']=='account_mismatch'
    assert store.identity('owner','subject') is None
    wait_for(lambda:not list(ram.iterdir()))

def test_pty_fixture_cancel_removes_temporary_configuration(tmp_path):
    store=Store(tmp_path/'db',b'k'*32);ram=tmp_path/'ram';ram.mkdir()
    binary=fixture_cli(tmp_path,"import time\nprint('First copy your one-time code: ABCD-1234',flush=True)\ntime.sleep(10)\n")
    login=Login(binary,ram,store);login.start('owner','subject');wait_for(lambda:login.status('owner','subject').get('user_code'))
    login.cancel();wait_for(lambda:not list(ram.iterdir()))
    assert store.identity('owner','subject') is None
