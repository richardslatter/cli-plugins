"""Install pinned official Linux amd64 release; fail closed on checksum mismatch."""
import hashlib,io,platform,tarfile,urllib.request
from pathlib import Path
VERSION='2.101.0'
SHA256='9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8'
if platform.system()!='Linux' or platform.machine() not in ('x86_64','amd64'):
    raise SystemExit('This deployment pins the verified Linux amd64 release. Verify an architecture-specific release before changing it.')
url=f'https://github.com/cli/cli/releases/download/v{VERSION}/gh_{VERSION}_linux_amd64.tar.gz'
data=urllib.request.urlopen(url,timeout=60).read()
if hashlib.sha256(data).hexdigest()!=SHA256:raise SystemExit('Official release checksum mismatch')
with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
    member=archive.getmember(f'gh_{VERSION}_linux_amd64/bin/gh')
    if not member.isfile():raise SystemExit('Unexpected binary archive member')
    Path('/usr/local/bin/gh').write_bytes(archive.extractfile(member).read())
Path('/usr/local/bin/gh').chmod(0o755)
