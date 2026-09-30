"""Fixed, read-only GitHub CLI operations. No user-controlled commands or hosts."""
import base64
import json
import os
import re
import selectors
import signal
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import quote, urlencode, urlparse, parse_qs
from pydantic import BaseModel, ConfigDict, Field, field_validator

GH_VERSION = '2.101.0'
MAX_OUTPUT = 2 * 1024 * 1024
SEMAPHORE = threading.BoundedSemaphore(4)

class Fault(Exception):
    def __init__(self, code, message, **details):
        self.data = dict(code=code, message=message, **details)
        super().__init__(code)

class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class Page(Input):
    page: int = Field(default=1, ge=1, le=10000)
    per_page: int = Field(default=50, ge=1, le=100)

class Repo(Input):
    repository: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$')
    @field_validator('repository')
    @classmethod
    def repo_safe(cls, v):
        if v.split('/')[1] in ('.', '..'): raise ValueError('Invalid repository')
        return v

class RepoPage(Repo, Page): pass

class Revision(Repo):
    ref: str = Field(min_length=1, max_length=240)
    @field_validator('ref')
    @classmethod
    def ref_safe(cls, v):
        if v.startswith(('-', '/', '.')) or '..' in v or any(ord(c)<33 or c in '~^:?*[\\' for c in v):
            raise ValueError('Use a branch, tag, or commit SHA')
        return v

class File(Revision):
    path: str = Field(default='', max_length=1024)
    @field_validator('path')
    @classmethod
    def path_safe(cls, v):
        if v.startswith('/') or '\\' in v or any(ord(c)<32 for c in v) or any(x in ('.','..') for x in v.split('/')):
            raise ValueError('Use a relative repository path without traversal')
        return v

class Directory(File):
    offset: int = Field(default=0, ge=0, le=1000)
    limit: int = Field(default=100, ge=1, le=300)

class TextFile(File):
    start_line: int = Field(default=1, ge=1, le=1000000)
    end_line: int = Field(default=200, ge=1, le=1000000)

class Search(Page):
    query: str = Field(min_length=1, max_length=250)
    repository: str | None = None
    organisation: str | None = Field(default=None, pattern=r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}$')
    language: str | None = Field(default=None, pattern=r'^[A-Za-z0-9+#.-]{1,40}$')
    filename: str | None = Field(default=None, pattern=r'^[A-Za-z0-9_.-]{1,100}$')
    @field_validator('repository')
    @classmethod
    def repo_safe(cls,v):
        if v is not None: Repo(repository=v)
        return v
    @field_validator('query')
    @classmethod
    def query_safe(cls,v):
        if any(ord(c)<32 for c in v) or ':' in v or re.search(r'\b(?:OR|NOT)\b',v) or v.startswith('-'):
            raise ValueError('Use search terms; supply qualifiers through dedicated fields')
        return v

class Issues(RepoPage):
    state: Literal['open','closed','all'] = 'open'

class Number(Repo):
    number: int = Field(ge=1, le=2147483647)

class NumberPage(Number, Page): pass

class Commits(RepoPage):
    ref: str | None = None
    @field_validator('ref')
    @classmethod
    def ref_safe(cls,v):
        if v is not None: Revision.ref_safe(v)
        return v

class Commit(Repo):
    sha: str = Field(pattern=r'^[0-9a-fA-F]{40}$')

SCHEMAS = {
 'account': (Input, 'Verify the connected GitHub account and immutable identity.'),
 'organisations': (Page, 'List authenticated organisation memberships. Outside collaborator access is separate.'),
 'repositories': (Page, 'List owned, collaborator and organisation-member repositories. Follow next_page until null; merge by stable id.'),
 'directory': (Directory, 'Browse a directory at a resolved commit; report continuation and API limits.'),
 'read_file': (TextFile, 'Read bounded UTF-8 text lines at a resolved revision; reject binary, large and LFS content.'),
 'search_code': (Search, 'Search indexed default-branch code through the legacy GitHub API; at most 1000 results, no regex guarantee.'),
 'issues': (Issues, 'List issues, excluding pull requests, with explicit continuation.'),
 'issue': (Number, 'Read a single issue. Use issue_comments for paginated comments.'),
 'issue_comments': (NumberPage, 'Read a page of issue or pull-request conversation comments.'),
 'pull_requests': (Issues, 'List pull requests with continuation.'),
 'pull_request': (Number, 'Read a pull request; comments, reviews, files and diff use separate tools.'),
 'pull_request_reviews': (NumberPage, 'Read a page of submitted pull request reviews.'),
 'pull_request_review_comments': (NumberPage, 'Read a page of inline pull request review comments.'),
 'pull_request_files': (NumberPage, 'Read changed files and supplied patches. GitHub caps this endpoint at 3000 files; patches may be incomplete.'),
 'pull_request_diff': (Number, 'Read the GitHub diff representation with an explicit output limit.'),
 'commits': (Commits, 'List recent commits; follow next_page.'),
 'commit': (Commit, 'Read commit metadata and first page of changed files; use commit_files for continuation.'),
 'commit_files': (type('CommitFiles',(Commit,Page),{}), 'Read a page of commit files; patches may be incomplete.'),
}

def safe_env(config, token=None):
    env = {'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(config),'GH_CONFIG_DIR':str(config),
           'XDG_CONFIG_HOME':str(config),'GH_HOST':'github.com','GH_PROMPT_DISABLED':'1',
           'GH_PAGER':'cat','PAGER':'cat','GH_BROWSER':'/bin/true','NO_COLOR':'1',
           'GH_NO_UPDATE_NOTIFIER':'1','GH_NO_EXTENSION_UPDATE_NOTIFIER':'1',
           'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','TERM':'dumb'}
    if token: env['GH_TOKEN'] = token
    return env

def execute(binary, args, config, token=None, timeout=25):
    if not SEMAPHORE.acquire(timeout=1): raise Fault('busy','Backend concurrency limit; retry later.')
    try:
        p = subprocess.Popen([str(binary),*args],env=safe_env(config,token),cwd=config,
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        chunks = {p.stdout:bytearray(), p.stderr:bytearray()}; deadline=time.monotonic()+timeout
        try:
            with selectors.DefaultSelector() as sel:
                for stream in chunks: sel.register(stream,selectors.EVENT_READ)
                while sel.get_map():
                    if time.monotonic()>deadline: raise Fault('timeout','GitHub CLI request timed out.')
                    for key,_ in sel.select(.1):
                        data=os.read(key.fileobj.fileno(),65536)
                        if not data: sel.unregister(key.fileobj); continue
                        chunks[key.fileobj].extend(data)
                        if sum(map(len,chunks.values()))>MAX_OUTPUT: raise Fault('output_limit','Response exceeded the safe byte limit; narrow this request.')
            p.wait(timeout=max(.1,deadline-time.monotonic()))
            return p.returncode,bytes(chunks[p.stdout]),bytes(chunks[p.stderr])
        finally:
            if p.poll() is None:
                os.killpg(p.pid,signal.SIGKILL);p.wait()
            p.stdout.close();p.stderr.close()
    finally: SEMAPHORE.release()

def parse_response(raw):
    raw=raw.replace(b'\r\n',b'\n'); head,sep,body=raw.partition(b'\n\n')
    if not sep or not head.startswith(b'HTTP/'): raise Fault('backend_failure','CLI returned an unrecognised HTTP response.')
    lines=head.decode('utf-8','replace').splitlines();status=int(lines[0].split()[1])
    headers={k.strip().lower():v.strip() for line in lines[1:] if ':' in line for k,v in [line.split(':',1)]}
    return status,headers,body

def error_response(status,h,body):
    msg=body.decode('utf-8','replace').lower()
    if status==401: return Fault('authentication_expired','GitHub rejected the credential. Reconnect through the secure Site.')
    if 'required' in h.get('x-github-sso',''): return Fault('sso_required','GitHub requires organisation SSO authorisation. Complete it directly at GitHub.')
    if status==429 or (status==403 and (h.get('x-ratelimit-remaining')=='0' or 'rate limit' in msg)):
        return Fault('rate_limited','GitHub rate limit reached; retry after the indicated time.',retry_after=h.get('retry-after'),reset_at=h.get('x-ratelimit-reset'))
    if status==404: return Fault('not_found_or_inaccessible','GitHub returned 404; absence and insufficient access cannot be distinguished.')
    if status==403:
        return Fault('forbidden','GitHub denied access; scopes, SSO, network or organisation policy may apply.',accepted_scopes=h.get('x-accepted-oauth-scopes'))
    if status in (400,422): return Fault('invalid_input','GitHub rejected this request.')
    return Fault('github_failure','GitHub request failed.',http_status=status)

def next_page(headers):
    for part in headers.get('link','').split(','):
        if 'rel="next"' not in part: continue
        match=re.search(r'<([^>]+)>',part)
        if match:
            url=urlparse(match[1])
            if url.scheme=='https' and url.netloc=='api.github.com':
                p=parse_qs(url.query).get('page',[''])[0]
                if p.isdigit(): return int(p)
    return None

def paginate(items,headers,args,**extra):
    nxt=next_page(headers)
    return dict(items=items,page=args.page,per_page=args.per_page,next_page=nxt,complete=nxt is None,truncated=False,**extra)

class GitHub:
    def __init__(self,binary,temp_root,token): self.binary=binary;self.temp_root=temp_root;self.token=token
    def api(self,path,params=None,accept='application/vnd.github+json',text=False):
        endpoint=path+('?' + urlencode(params) if params else '')
        with tempfile.TemporaryDirectory(prefix='request-',dir=self.temp_root) as d:
            for attempt in range(2):
                code,out,_=execute(self.binary,['api','--hostname','github.com','--method','GET','--include',
                    '-H','Accept: '+accept,'-H','X-GitHub-Api-Version: 2022-11-28',endpoint],d,self.token)
                if not out: raise Fault('backend_failure','CLI request failed without an HTTP response.')
                status,h,body=parse_response(out)
                if 200<=status<300:
                    try:return (body.decode('utf-8') if text else json.loads(body)),h
                    except (ValueError,UnicodeError): raise Fault('backend_failure','GitHub response could not be decoded.')
                # Retry only short Retry-After values; otherwise return the schedule to the caller.
                fault=error_response(status,h,body);delay=h.get('retry-after','')
                if attempt==0 and fault.data['code']=='rate_limited' and delay.isdigit() and 0<int(delay)<=2:
                    time.sleep(int(delay));continue
                if attempt==0 and status in (502,503,504):time.sleep(1);continue
                raise fault

    def run(self,name,arguments):
        if name not in SCHEMAS: raise Fault('unknown_tool','This operation is not allowed.')
        a=SCHEMAS[name][0].model_validate(arguments)
        root='repos/'+a.repository if hasattr(a,'repository') and a.repository else None
        page={'page':a.page,'per_page':a.per_page} if isinstance(a,Page) else {}
        if name=='account':
            u,h=self.api('user');return dict(id=str(u['id']),login=u['login'],url=u['html_url'],scopes=h.get('x-oauth-scopes','').split(', '),read_only_enforced=True)
        if name=='repositories':
            rows,h=self.api('user/repos',dict(page,visibility='all',affiliation='owner,collaborator,organization_member',sort='full_name',direction='asc'))
            rows={r['id']:{k:r.get(k) for k in ['id','name','full_name','visibility','private','default_branch','html_url','permissions']}|{'owner':r['owner']['login']} for r in rows}
            return paginate(list(rows.values()),h,a,enumeration='authenticated_user',source_url='https://github.com/settings/repositories')
        if name=='organisations':
            rows,h=self.api('user/memberships/orgs',dict(page,state='active'))
            return paginate([{'id':r['organization']['id'],'login':r['organization']['login'],'url':'https://github.com/'+r['organization']['login'],'role':r.get('role'),'membership':r.get('state')} for r in rows],h,a)
        if name in ('directory','read_file'):
            commit,_=self.api(root+'/commits/'+quote(a.ref,safe=''));sha=commit['sha']
            data,_=self.api(root+'/contents/'+quote(a.path,safe='/'),{'ref':sha})
            url='https://github.com/'+a.repository+('/tree/' if name=='directory' else '/blob/')+sha+'/'+quote(a.path,safe='/')
            if name=='directory':
                if not isinstance(data,list):raise Fault('not_directory','Requested path is not a directory.')
                rows=[{k:x.get(k) for k in ('name','path','type','sha','size','html_url','submodule_git_url')} for x in data]
                rows=rows[a.offset:a.offset+a.limit];nxt=a.offset+a.limit if a.offset+a.limit<len(data) else None
                return dict(items=rows,path=a.path,revision=sha,url=url,next_offset=nxt,truncated=nxt is not None or len(data)>=1000,complete=nxt is None and len(data)<1000,api_directory_cap=1000)
            if not isinstance(data,dict) or data.get('type')!='file' or data.get('submodule_git_url'):raise Fault('not_text_file','Path is a directory, symlink or submodule.')
            if a.end_line<a.start_line or a.end_line-a.start_line>=500:raise Fault('invalid_input','Request between 1 and 500 lines.')
            if data.get('size',0)>524288 or data.get('encoding')!='base64':raise Fault('large_file','File exceeds the 512 KiB text limit or content is unavailable.')
            try:
                raw=base64.b64decode(data['content']);content=raw.decode('utf-8')
            except (ValueError,UnicodeError):raise Fault('binary_file','File is not UTF-8 text.')
            if '\x00' in content:raise Fault('binary_file','File contains binary data.')
            if content.startswith('version https://git-lfs.github.com/spec/v1'):raise Fault('lfs_pointer','This file is an LFS pointer; object content has not been fetched.')
            lines=content.splitlines();selected=lines[a.start_line-1:a.end_line];text='\n'.join(selected)
            if len(text.encode())>100000:raise Fault('output_limit','Selected lines are too large; narrow the range.')
            end=min(a.end_line,len(lines))
            return dict(path=a.path,revision=sha,blob_sha=data['sha'],start_line=a.start_line,end_line=end,total_lines=len(lines),content=text,url=url+f'#L{a.start_line}-L{end}',truncated=end<len(lines),next_line=end+1 if end<len(lines) else None)
        if name=='search_code':
            if not a.repository and not a.organisation:raise Fault('invalid_input','Supply a repository or organisation to scope the search.')
            q=a.query
            for field,qual in [('repository','repo'),('organisation','org'),('language','language'),('filename','filename')]:
                if getattr(a,field):q+=' '+qual+':'+getattr(a,field)
            if a.page*a.per_page>1000:raise Fault('search_cap','GitHub code search exposes at most 1000 results; narrow the query.')
            data,h=self.api('search/code',dict(page,q=q));result=paginate(data.get('items',[]),h,a,total_count=data.get('total_count'),incomplete_results=data.get('incomplete_results',False),coverage='Indexed default branch only; legacy engine; no regex guarantee',result_cap=1000)
            result['truncated']=data.get('incomplete_results',False) or data.get('total_count',0)>1000
            result['complete']=result['complete'] and not result['truncated'];return result
        if name in ('issues','pull_requests'):
            rows,h=self.api(root+('/issues' if name=='issues' else '/pulls'),dict(page,state=a.state))
            if name=='issues':rows=[r for r in rows if 'pull_request' not in r]
            return paginate(rows,h,a)
        route={ 'issue':f'/issues/{getattr(a,"number",0)}','issue_comments':f'/issues/{getattr(a,"number",0)}/comments',
          'pull_request':f'/pulls/{getattr(a,"number",0)}','pull_request_reviews':f'/pulls/{getattr(a,"number",0)}/reviews',
          'pull_request_review_comments':f'/pulls/{getattr(a,"number",0)}/comments','pull_request_files':f'/pulls/{getattr(a,"number",0)}/files',
          'pull_request_diff':f'/pulls/{getattr(a,"number",0)}','commits':'/commits',
          'commit':f'/commits/{getattr(a,"sha","")}','commit_files':f'/commits/{getattr(a,"sha","")}'}[name]
        if name=='pull_request_diff':
            diff,_=self.api(root+route,accept='application/vnd.github.diff',text=True)
            return dict(diff=diff[:100000],truncated=len(diff)>100000,upstream_completeness='not guaranteed for binary or oversized diffs',url='https://github.com/'+a.repository+f'/pull/{a.number}/files')
        if name=='commits' and a.ref:page['sha']=a.ref
        data,h=self.api(root+route,page)
        if name=='commit_files':return paginate(data.get('files',[]),h,a,patches_may_be_incomplete=True)
        if isinstance(a,Page):
            result=paginate(data,h,a)
            if name=='pull_request_files':
                result.update(patches_may_be_incomplete=True,api_file_cap=3000)
                if a.page*a.per_page>=3000:result.update(complete=False,truncated=True)
            return result
        if name=='commit':return dict(data=data,next_page=next_page(h),files_complete=next_page(h) is None,patches_may_be_incomplete=True)
        return dict(data=data)
