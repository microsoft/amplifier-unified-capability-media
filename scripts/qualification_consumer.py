"""Exclusive task-owned npm consumer; never discover or adopt a parent project."""
import json
from pathlib import Path
import uuid

MARKER = '.amplifier-media-qualification.json'


def prepare_consumer(root):
    root = Path(root).resolve(strict=True)
    consumer = root / 'consumer'
    # Even an empty existing directory may belong to another caller. Refuse it.
    consumer.mkdir(mode=0o700, exist_ok=False)
    identity = {'owner': 'amplifier-unified-media-qualification', 'version': 1,
                'root': str(root), 'consumer': str(consumer), 'id': uuid.uuid4().hex}
    for name, value in [(MARKER, identity), ('package.json', {
        'name': 'amplifier-media-owned-qualification-consumer', 'version': '0.0.0',
        'private': True, 'x-amplifier-qualification': identity['id'],
    })]:
        with (consumer / name).open('x') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
        (consumer / name).chmod(0o600)
    verify_consumer(root, consumer)
    return consumer


def verify_consumer(root, consumer):
    root = Path(root).resolve(strict=True)
    consumer = Path(consumer)
    if consumer.is_symlink() or consumer.resolve(strict=True) != root / 'consumer':
        raise ValueError('Qualification consumer must stay inside its exact owned root')
    for name in [MARKER, 'package.json']:
        if (consumer / name).is_symlink():
            raise ValueError('Qualification ownership metadata cannot be a symlink')
    identity = json.loads((consumer / MARKER).read_text())
    manifest = json.loads((consumer / 'package.json').read_text())
    if (identity.get('owner') != 'amplifier-unified-media-qualification'
            or identity.get('version') != 1 or identity.get('root') != str(root)
            or identity.get('consumer') != str(consumer) or not identity.get('id')
            or manifest.get('private') is not True
            or manifest.get('x-amplifier-qualification') != identity['id']):
        raise ValueError('Exact qualification ownership marker and manifest required')
    for path in [consumer / '.npm-cache', consumer / 'node_modules', consumer / 'node_modules/@amplifier',
                 consumer / 'node_modules/@amplifier/unified-media-capability']:
        if path.is_symlink() or not path.resolve().is_relative_to(consumer):
            raise ValueError('Qualification installation escaped its owned consumer')
    return consumer


def install_archive(root, consumer, archive, run):
    consumer = verify_consumer(root, consumer)
    npm = ['npm', '--prefix', str(consumer), '--global=false']
    prefix = Path(run(npm + ['prefix'], consumer, 'npm-prefix.log').strip())
    modules = Path(run(npm + ['root'], consumer, 'npm-root.log').strip())
    if prefix != consumer or modules != consumer / 'node_modules':
        raise ValueError('npm resolved a foreign prefix or installation directory')
    verify_consumer(root, consumer)
    run(npm + ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
               '--workspaces=false', '--cache', str(consumer / '.npm-cache'),
               str(Path(archive).resolve(strict=True))], consumer, 'install-node.log')
    verify_consumer(root, consumer)
