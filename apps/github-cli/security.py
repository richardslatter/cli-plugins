import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from core import Fault

def key_from_file(path):
    key=base64.b64decode(Path(path).read_text().strip(),validate=True)
    if len(key)!=32:raise RuntimeError('Secret key must contain 32 base64-encoded bytes')
    return key

class Store:
    def __init__(self,path,key):
        self.path=str(path);self.aead=AESGCM(key)
        Path(path).parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        with self.db() as db:
            db.execute('PRAGMA journal_mode=DELETE')
            db.execute('PRAGMA secure_delete=ON')
            db.execute('CREATE TABLE IF NOT EXISTS connection (owner TEXT PRIMARY KEY, subject TEXT NOT NULL, github_id TEXT NOT NULL, login TEXT NOT NULL, nonce BLOB, ciphertext BLOB)')
            db.execute('CREATE TABLE IF NOT EXISTS replay (nonce TEXT PRIMARY KEY, created INTEGER NOT NULL)')
        os.chmod(self.path,0o600)
    def db(self):
        db=sqlite3.connect(self.path,timeout=5);db.execute('PRAGMA secure_delete=ON');return db
    def claim_nonce(self,nonce,now):
        with self.db() as db:
            db.execute('DELETE FROM replay WHERE created < ?',(now-120,))
            try:db.execute('INSERT INTO replay VALUES (?,?)',(nonce,now))
            except sqlite3.IntegrityError:raise Fault('request_replayed','Request was already used.')
    def identity(self,owner,subject):
        with self.db() as db:row=db.execute('SELECT subject,github_id,login,ciphertext IS NOT NULL FROM connection WHERE owner=?',(owner,)).fetchone()
        if row and row[0]!=subject:raise Fault('wrong_owner','Authenticated Site identity does not match the saved connection.')
        return {'id':row[1],'login':row[2],'connected':bool(row[3])} if row else None
    def save(self,owner,subject,account,token):
        current=self.identity(owner,subject)
        if account['login'].casefold()!='rick-colosl' or current and current['id']!=str(account['id']):
            raise Fault('account_mismatch','Authorise the required rick-colosl account; no credential was retained.')
        nonce=os.urandom(12);aad=json.dumps([owner,subject,str(account['id'])]).encode()
        ciphertext=self.aead.encrypt(nonce,token.encode(),aad)
        with self.db() as db:db.execute('INSERT OR REPLACE INTO connection VALUES (?,?,?,?,?,?)',(owner,subject,str(account['id']),account['login'],nonce,ciphertext))
    def token(self,owner,subject):
        identity=self.identity(owner,subject)
        if not identity or not identity['connected']:raise Fault('not_connected','Connect GitHub on the private Site.')
        with self.db() as db:nonce,ciphertext=db.execute('SELECT nonce,ciphertext FROM connection WHERE owner=?',(owner,)).fetchone()
        aad=json.dumps([owner,subject,identity['id']]).encode()
        try:return self.aead.decrypt(nonce,ciphertext,aad).decode()
        except Exception:raise Fault('credential_unavailable','Encrypted credential cannot be read; check the managed key, then reconnect if necessary.')
    def disconnect(self,owner,subject):
        self.identity(owner,subject)
        with self.db() as db:db.execute('UPDATE connection SET nonce=NULL,ciphertext=NULL WHERE owner=?',(owner,))

def verify_request(body,headers,key,store,expected_owner,now=None):
    now=int(time.time()) if now is None else now
    stamp=headers.get('x-bridge-time','');nonce=headers.get('x-bridge-nonce','');signature=headers.get('x-bridge-signature','')
    if not stamp.isdigit() or abs(now-int(stamp))>60 or not re.fullmatch(r'[a-f0-9]{32}',nonce):raise Fault('unauthorized','A current authenticated gateway request is required.')
    message=(stamp+'\n'+nonce+'\nPOST\n/rpc\n'+hashlib.sha256(body).hexdigest()).encode()
    if not hmac.compare_digest(hmac.new(key,message,hashlib.sha256).hexdigest(),signature):raise Fault('unauthorized','Invalid gateway signature.')
    try:data=json.loads(body)
    except ValueError:raise Fault('invalid_input','Expected a JSON request.')
    if set(data)!={'owner','subject','operation','arguments'} or data['owner']!=expected_owner or not isinstance(data['subject'],str) or not 1<=len(data['subject'])<=200:
        raise Fault('wrong_owner','Request is not bound to the configured owner.')
    store.claim_nonce(nonce,now);store.identity(data['owner'],data['subject']);return data

def require_memory_filesystem(directory):
    """Fail closed; container /dev/shm is the default credential scratch space."""
    path=Path(directory).resolve()
    mounts=[]
    for line in Path('/proc/mounts').read_text().splitlines():
        fields=line.split();mount=Path(fields[1])
        if path==mount or mount in path.parents:mounts.append((len(str(mount)),fields[2]))
    if not mounts or max(mounts)[1] not in ('tmpfs','ramfs'):raise RuntimeError('CLI configuration must live on tmpfs/ramfs, never durable storage')
    path.mkdir(mode=0o700,parents=True,exist_ok=True);path.chmod(0o700)
