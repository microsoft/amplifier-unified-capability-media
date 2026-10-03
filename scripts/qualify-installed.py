"""Seal and exercise media from independent installed consumers, never edit peers."""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, zipfile
from pathlib import Path
from qualification_consumer import prepare_consumer, install_archive
parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--python',required=True);parser.add_argument('--peer-handoff');args=parser.parse_args()
source=Path(__file__).resolve().parents[1];out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
env={k:v for k,v in os.environ.items() if k not in {'PYTHONPATH','PYTHONHOME'}};env['PYTHONDONTWRITEBYTECODE']='1'
def run(command,cwd,log):
    result=subprocess.run(command,cwd=cwd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (out/log).write_text(result.stdout)
    if result.returncode:raise RuntimeError(f'{log}: exit {result.returncode}')
    return result.stdout
consumer=prepare_consumer(out)
peer=None
if args.peer_handoff:
    packet=Path(args.peer_handoff).resolve();peer=json.loads(packet.read_text());native=peer['native']['nativeWheel'];nativeWheel=Path(native['path']);assert hashlib.sha256(nativeWheel.read_bytes()).hexdigest()==native['sha256']
    executable=peer['readOnlyExecutables']['nativePython'];module=Path(run([executable,'-c','import amplifier_acp; print(amplifier_acp.__path__[0])'],out,'native-peer-import.log').strip())
    with zipfile.ZipFile(nativeWheel) as archive:
        members=[name for name in archive.namelist() if name.startswith('amplifier_acp/') and name.endswith('.py')]
        for name in members:assert archive.read(name)==(module.parent/name).read_bytes(),name
    peer={'handoff':str(packet),'handoffSha256':hashlib.sha256(packet.read_bytes()).hexdigest(),'nativeSource':peer['native']['source'],'nativeWheel':native,'nativeInstalledPythonFilesVerified':len(members),'distribution':peer['distribution']}
run(['npm','pack','--json','--pack-destination',str(out)],source,'pack.log')
archive=out/json.loads((out/'pack.log').read_text())[0]['filename']
run(['uv','build','--wheel','--out-dir',str(out)],source,'wheel-build.log');wheel=next(out.glob('*.whl'))
install_archive(out,consumer,archive,run)
package=consumer/'node_modules/@amplifier/unified-media-capability';tests=consumer/'test';tests.mkdir(exist_ok=True)
for file in (source/'test').iterdir():
    if file.suffix=='.mjs':
        text=file.read_text();text=re.sub(r"(['\"])\.\./src/([^'\"]+)\1",lambda match:repr((package/'src'/match[2]).as_uri()),text);(tests/file.name).write_text(text)
    elif file.suffix=='.py':shutil.copyfile(file,tests/file.name)
# The owner is small; its wheel gets a separate venv. Peers supplied by the
# coordinator are executed read-only via environment pointers, never installed here.
pythonHome=out/'python';run(['uv','venv','--python',args.python,str(pythonHome)],out,'venv.log')
python=pythonHome/'bin/python';run(['uv','pip','install','--python',str(python),str(wheel),'aiohttp>=3.12,<4','pytest>=8','pytest-asyncio>=0.24'],out,'install-python.log')
env['MEDIA_CAPABILITY_MODULE']=(package/'src/index.js').as_uri();env['MEDIA_WORKER_PYTHON']=str(python);env['MEDIA_ACCEPTANCE_RECEIPT']=str(out/'native-transcript-receipt.json')
run(['node','--test',*[str(p) for p in sorted(tests.glob('*.mjs'))]],consumer,'installed-node-tests.log')
run([str(python),'-m','pytest','-q','--import-mode=importlib','-o','asyncio_mode=auto',str(tests)],consumer,'installed-python-tests.log')
installed=Path(run([str(python),'-c','import amplifier_unified_media; print(amplifier_unified_media.__path__[0])'],consumer,'python-import.log').strip())
verified=[]
for path in (source/'src').glob('*.js'):
    assert path.read_bytes()==(package/'src'/path.name).read_bytes();verified.append('src/'+path.name)
for path in (source/'python/amplifier_unified_media').iterdir():
    if path.suffix in {'.py','.json'}:
        assert path.read_bytes()==(installed/path.name).read_bytes()==(package/'python/amplifier_unified_media'/path.name).read_bytes();verified.append('python/amplifier_unified_media/'+path.name)
receipt={'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip(),'packageVersions':{'node':json.loads((package/'package.json').read_text())['version'],'python':'0.1.0'},'archives':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [archive,wheel]],'verifiedSourceFiles':verified,'installedPython':str(python),'nodeEntry':env['MEDIA_CAPABILITY_MODULE'],'peerReceipt':peer,'peerInputs':{k:v for k,v in env.items() if k in {'MEDIA_NATIVE_ADMIN_MODULE','MEDIA_NATIVE_PYTHON','MEDIA_NATIVE_HOST_MODULE'}},'limits':['Offline fixture transport only; no device, capture, model, account, release or deployment acceptance.','Native peer source currency is governed by its independent input receipt.']}
(out/'installed-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
