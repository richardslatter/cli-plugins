"""Pinned official npm release; verify integrity before selecting the ELF binary."""
import base64
import hashlib
import io
import platform
import tarfile
import urllib.request
from pathlib import Path
VERSION='0.23.13'
INTEGRITY='2YfWRjtYJJa3eIR1BOmCwEsclqbiR62468M7t30We3eBFmTsoPADiPlLG2WjZ1TiVv8ONSJ3VyVUauCzl3X4VA=='
if platform.system()!='Linux' or platform.machine() not in ('x86_64','amd64'):
    raise SystemExit('Only the verified Linux amd64 release is supported.')
data=urllib.request.urlopen(f'https://registry.npmjs.org/ntn/-/ntn-{VERSION}.tgz',timeout=60).read()
if base64.b64encode(hashlib.sha512(data).digest()).decode()!=INTEGRITY:
    raise SystemExit('Official ntn release integrity mismatch.')
with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
    member=archive.getmember('package/dist/ntn-linux-x64/ntn')
    if not member.isfile():raise SystemExit('Invalid ntn binary archive entry.')
    Path('/usr/local/bin/ntn').write_bytes(archive.extractfile(member).read())
Path('/usr/local/bin/ntn').chmod(0o755)
