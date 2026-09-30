"""Own a real gh login process. No OAuth client impersonation or token input."""
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path
import yaml
from core import Fault, GitHub, safe_env

class Login:
    def __init__(self,binary,temp_root,store):
        self.binary=binary;self.temp_root=temp_root;self.store=store
        self.lock=threading.RLock();self.job=None
    def status(self,owner,subject):
        with self.lock:
            j=self.job
            if not j or j['owner']!=owner or j['subject']!=subject:return {'state':'idle'}
            return {k:j.get(k) for k in ('state','user_code','verification_url','expires_at','error')}
    def start(self,owner,subject):
        with self.lock:
            if self.job and self.job['state']=='pending':
                if self.job['owner']!=owner or self.job['subject']!=subject:raise Fault('busy','Another login is pending.')
                return self.status(owner,subject)
            self.job={'owner':owner,'subject':subject,'state':'pending','expires_at':int(time.time())+600,'cancel':threading.Event()}
            threading.Thread(target=self._run,args=(self.job,),daemon=True).start()
            return self.status(owner,subject)
    def cancel(self):
        with self.lock:
            if self.job and self.job['state']=='pending':
                self.job['cancel'].set();self.job['state']='cancelled';self.job['user_code']=None
    def _run(self,j):
        directory=tempfile.mkdtemp(prefix='login-',dir=self.temp_root);master,slave=pty.openpty();p=None
        try:
            env=safe_env(directory);env.pop('GH_PROMPT_DISABLED',None)
            # Explicit plaintext storage is confined to verified tmpfs, then encrypted and deleted.
            p=subprocess.Popen([str(self.binary),'auth','login','--hostname','github.com','--git-protocol','https','--web','--skip-ssh-key','--insecure-storage'],
               cwd=directory,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
            os.close(slave);slave=None;buf='';sent=False
            while p.poll() is None:
                if j['cancel'].is_set():raise Fault('login_cancelled','Login cancelled; start a new connection when ready.')
                if time.time()>j['expires_at']:raise Fault('login_timeout','Login timed out; start a fresh GitHub authorisation.')
                if select.select([master],[],[],.2)[0]:
                    try:chunk=os.read(master,4096)
                    except OSError:break
                    buf=(buf+chunk.decode('utf-8','replace'))[-16000:]
                    code=re.search(r'(?:one-time code|code):\s*([A-Z0-9]{4}-[A-Z0-9]{4})',buf,re.I)
                    if code:
                        with self.lock:j.update(user_code=code.group(1),verification_url='https://github.com/login/device')
                    if not sent and ('Press Enter' in buf or 'press Enter' in buf):os.write(master,b'\n');sent=True
            p.wait(timeout=5)
            if p.returncode:raise Fault('login_failed','GitHub CLI login failed or was declined; reconnect to try again.')
            with self.lock:
                if j['cancel'].is_set():raise Fault('login_cancelled','Login was cancelled.')
                config=Path(directory)/'hosts.yml'
                if not config.is_file():raise Fault('credential_unavailable','CLI did not write the expected temporary configuration.')
                # Temporary directory is mode 0700; tighten file permissions before reading.
                config.chmod(0o600);host=yaml.safe_load(config.read_text()).get('github.com',{})
                token=host.get('oauth_token') or host.get('users',{}).get(host.get('user'),{}).get('oauth_token')
                if not token:raise Fault('credential_unavailable','CLI credential was not available in its protected temporary config.')
                account=GitHub(self.binary,self.temp_root,token).run('account',{})
                self.store.save(j['owner'],j['subject'],account,token)
                j.update(state='connected',user_code=None,verification_url=None)
        except Fault as e:
            with self.lock:j.update(state='failed',user_code=None,error=e.data)
        except Exception:
            with self.lock:j.update(state='failed',user_code=None,error={'code':'login_failed','message':'Login failed. No raw CLI output is logged.'})
        finally:
            if p and p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait()
            os.close(master)
            if slave is not None:os.close(slave)
            shutil.rmtree(directory)
