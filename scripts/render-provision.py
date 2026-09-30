"""Provision the reviewed single-service plan through Render's public API.

Authenticate with `render login` first. Reuses the official CLI's credential
configuration, never prints credentials, and never automates a browser.
"""
import argparse
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
import yaml

WORKSPACE='tea-dau6voqd0e5s73egtf9g'
REPO='https://github.com/richardslatter/cli-plugins'
API='https://api.render.com/v1/'


def cli_credential():
    # The CLI performs any required refresh using its supported login state.
    result=subprocess.run(['render','workspaces','--output','json'],capture_output=True,text=True)
    if result.returncode:raise RuntimeError('Run render login before provisioning.')
    key=os.environ.get('RENDER_API_KEY')
    if not key:
        config=Path(os.environ.get('RENDER_CLI_CONFIG_PATH') or str(Path(os.environ.get('RENDER_CLI_CONFIG_DIR',str(Path.home()/'.render')))/'cli.yaml')).expanduser()
        data=yaml.safe_load(config.read_text())
        key=data.get('api',{}).get('key')
    if not key:raise RuntimeError('Render CLI has no usable credential.')
    return key


def api(key,method,path,data=None):
    if path.startswith('/') or '://' in path:raise RuntimeError('Use an API-relative path.')
    request=urllib.request.Request(API+path,data=json.dumps(data).encode() if data is not None else None,
        headers={'Authorization':'Bearer '+key,'Accept':'application/json','Content-Type':'application/json'},method=method)
    try:
        with urllib.request.urlopen(request,timeout=60) as response:return json.load(response)
    except urllib.error.HTTPError as error:
        # Error bodies may echo submitted configuration. Do not log them.
        raise RuntimeError(f'Render API returned HTTP {error.code}. No credentials or request body were logged.') from None


def provision(args):
    os.umask(0o077)
    key=cli_credential()
    data=json.loads(Path(args.teams_accounts_file).read_text())
    rows=data['accounts'] if isinstance(data,dict) else data
    profiles=[{k:p[k] for k in ('id','name','tenantName','tenantId','loginHint')} for p in rows]
    if not profiles:raise RuntimeError('At least one Teams profile is required.')
    state_file=Path(args.state_file).expanduser();state_file.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if state_file.exists():state=json.loads(state_file.read_text())
    else:
        state={'encryptionKey':secrets.token_hex(32)}
        state_file.write_text(json.dumps(state));state_file.chmod(0o600)
    found=[];cursor=None
    while True:
        query={'ownerId':WORKSPACE,'limit':'100'}
        if cursor:query['cursor']=cursor
        page=api(key,'GET','services?'+urllib.parse.urlencode(query))
        found += [item['service'] for item in page if item['service']['name']=='cli-plugins']
        if len(page)<100:break
        cursor=page[-1]['cursor']
    if len(found)>1:raise RuntimeError('Multiple matching services exist; inspect before proceeding.')
    if found:
        service=found[0]
        if service['ownerId']!=WORKSPACE or service['repo'].removesuffix('.git')!=REPO:
            raise RuntimeError('Existing service is not the expected workspace/repository.')
        print(json.dumps({'status':'exists','serviceId':service['id'],'url':service.get('serviceDetails',{}).get('url')}));return
    env={
        'NODE_ENV':'production','DATA_DIR':'/var/data',
        'NODE_OPTIONS':'--max-old-space-size=128',
        'TOKEN_ENCRYPTION_KEY':state['encryptionKey'],
        'TEAMS_ACCOUNTS_JSON':json.dumps(profiles,separators=(',',':')),
        'GITHUB_ALLOWED_LOGINS':args.github_logins,
    }
    body={'type':'web_service','name':'cli-plugins','ownerId':WORKSPACE,'repo':REPO,'branch':'main','autoDeploy':'no',
          'envVars':[{'key':k,'value':v} for k,v in env.items()],
          'serviceDetails':{'runtime':'docker','plan':'starter','region':'singapore','numInstances':1,
                            'healthCheckPath':'/healthz','maxShutdownDelaySeconds':30,
                            'disk':{'name':'cli-credentials','mountPath':'/var/data','sizeGB':1},
                            'envSpecificDetails':{'dockerfilePath':'./Dockerfile','dockerContext':'.'}}}
    result=api(key,'POST','services',body)
    service=result['service'];state['serviceId']=service['id'];state_file.write_text(json.dumps(state));state_file.chmod(0o600)
    print(json.dumps({'status':'created','serviceId':service['id'],'url':service.get('serviceDetails',{}).get('url'),
                      'deployId':result.get('deployId'),'plan':'starter','region':'singapore','diskGB':1}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--teams-accounts-file',required=True)
    parser.add_argument('--github-logins',required=True);parser.add_argument('--state-file',required=True)
    args=parser.parse_args()
    try:provision(args)
    except Exception as error:
        # Print only errors authored by this script; SDK/config/parser failures
        # can contain credential material and are intentionally generic.
        message=str(error) if isinstance(error,RuntimeError) else 'Provisioning could not finish. Check CLI authentication and private configuration.'
        print(message,file=sys.stderr);sys.exit(1)
