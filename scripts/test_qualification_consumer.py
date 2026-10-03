"""Focused qualification isolation regression; no media/native runtime execution."""
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from qualification_consumer import install_archive, prepare_consumer, verify_consumer


class ConsumerIsolation(unittest.TestCase):
    def test_real_npm_cannot_mutate_parent_project_or_modules(self):
        with tempfile.TemporaryDirectory(prefix='media-npm-owned-') as temporary:
            parent = Path(temporary)
            (parent / 'package.json').write_text(json.dumps({'name': 'foreign-parent', 'version': '1.0.0', 'private': True}))
            (parent / 'package-lock.json').write_text('{"foreign-parent":"unchanged"}\n')
            foreign = parent / 'node_modules/foreign-parent'
            foreign.mkdir(parents=True)
            (foreign / 'index.js').write_text('foreign parent bytes\n')
            protected = [parent / 'package.json', parent / 'package-lock.json', foreign / 'index.js']
            before = {path: path.read_bytes() for path in protected}
            owned = parent / 'owned'
            owned.mkdir()
            consumer = prepare_consumer(owned)
            archive = owned / 'fixture.tgz'
            with tarfile.open(archive, 'w:gz') as package:
                for name, content in [('package/package.json', json.dumps({'name': '@amplifier/unified-media-capability', 'version': '0.0.0', 'type': 'module'})), ('package/src/index.js', 'export const fixture = true;\n')]:
                    data = content.encode()
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    package.addfile(member, io.BytesIO(data))
            commands = []
            def run(command, cwd, log):
                commands.append(command)
                # Deliberately conflicting inherited options must not select the parent/global prefix.
                env = {**os.environ, 'npm_config_global': 'true', 'npm_config_prefix': str(parent)}
                result = subprocess.run(command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                self.assertEqual(result.returncode, 0, result.stdout)
                return result.stdout
            install_archive(owned, consumer, archive, run)
            self.assertTrue((consumer / 'node_modules/@amplifier/unified-media-capability/src/index.js').is_file())
            self.assertTrue((consumer / 'package-lock.json').is_file())
            self.assertEqual(before, {path: path.read_bytes() for path in protected})
            self.assertFalse((parent / 'node_modules/@amplifier').exists())
            for command in commands:
                self.assertEqual(command[1:4], ['--prefix', str(consumer), '--global=false'])
            self.assertIn('--workspaces=false', commands[-1])
            self.assertEqual(commands[-1][commands[-1].index('--cache') + 1], str(consumer / '.npm-cache'))

    def test_foreign_existing_consumer_is_never_adopted_or_clobbered(self):
        with tempfile.TemporaryDirectory(prefix='media-npm-foreign-') as temporary:
            root = Path(temporary)
            consumer = root / 'consumer'
            consumer.mkdir()
            (consumer / 'package.json').write_text('{"name":"foreign-consumer"}\n')
            before = (consumer / 'package.json').read_bytes()
            with self.assertRaises(FileExistsError):
                prepare_consumer(root)
            self.assertEqual((consumer / 'package.json').read_bytes(), before)
            self.assertEqual([p.name for p in consumer.iterdir()], ['package.json'])

    def test_npm_foreign_prefix_is_refused_before_install(self):
        with tempfile.TemporaryDirectory(prefix='media-npm-prefix-') as temporary:
            root = Path(temporary)
            consumer = prepare_consumer(root)
            calls = []
            def run(command, cwd, log):
                calls.append(command)
                return str(root if command[-1] == 'prefix' else root / 'node_modules')
            with self.assertRaisesRegex(ValueError, 'foreign prefix'):
                install_archive(root, consumer, root / 'unused.tgz', run)
            self.assertEqual(len(calls), 2)
            self.assertFalse(any('install' in command for command in calls))

    def test_ownership_or_symlink_escape_is_refused_before_install(self):
        with tempfile.TemporaryDirectory(prefix='media-npm-escape-') as temporary:
            root = Path(temporary)
            consumer = prepare_consumer(root)
            outside = root / 'outside'
            outside.mkdir()
            (consumer / 'node_modules').symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'escaped'):
                verify_consumer(root, consumer)
            (consumer / 'node_modules').unlink()
            manifest = json.loads((consumer / 'package.json').read_text())
            manifest['x-amplifier-qualification'] = 'foreign'
            (consumer / 'package.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'ownership'):
                verify_consumer(root, consumer)


if __name__ == '__main__':
    unittest.main()
