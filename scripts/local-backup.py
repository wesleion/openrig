#!/usr/bin/env python3
"""Private, consistent recovery snapshot. Does not stop or alter sessions."""
import hashlib
import json
import os
import sqlite3
import subprocess
import tarfile
from datetime import datetime, timezone
from pathlib import Path

os.umask(0o077)
home = Path.home()
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
root = home / '.openrig' / 'backups' / (stamp + '-native-bridge')
root.mkdir(parents=True, mode=0o700)
installed = home / '.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli'
source = sqlite3.connect(f'file:{home}/.openrig/openrig.sqlite?mode=ro', uri=True)
target = sqlite3.connect(root / 'openrig.sqlite')
source.backup(target)
assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
target.close()
source.close()

def archive(name, entries, excluded=()):
    def keep(info):
        if info.issock() if hasattr(info, 'issock') else False:
            return None
        if any(info.name == p or info.name.startswith(p + '/') for p in excluded):
            return None
        return info
    with tarfile.open(root / name, 'w:gz', compresslevel=1) as out:
        for path, label in entries:
            if path.exists():
                out.add(path, arcname=label, filter=keep)

archive('installed-openrig.tar.gz', [(installed, 'cli')])
archive('openrig-state.tar.gz', [(home / '.openrig', '.openrig')], (
    '.openrig/backups', '.openrig/maintenance', '.openrig/run',
    '.openrig/openrig.sqlite', '.openrig/openrig.sqlite-wal', '.openrig/openrig.sqlite-shm'))
archive('accounts-conversations.tar.gz', [(home / p, p) for p in ('.agent-homes', '.codex', '.claude')], (
    '.codex/tmp', '.codex/node_modules', '.codex/.cache'))
archive('recovery-shell.tar.gz', [(home / p, p) for p in (
    '.profile', '.bashrc', '.local/bin/rig', '.config/systemd/user/openrig.service',
    '.openrig/maintenance/20261007-kernel-recovery', '.openrig/maintenance/20261007-openrig-repair')])
panes = subprocess.run(['tmux', 'list-panes', '-a', '-F',
    '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}'],
    capture_output=True, text=True, check=False)
(root / 'panes-before.tsv').write_text(panes.stdout)
manifest = {'createdAt': stamp, 'databaseIntegrity': 'ok', 'files': {}}
for p in root.iterdir():
    if p.is_file():
        digest = hashlib.sha256()
        with p.open('rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                digest.update(chunk)
        manifest['files'][p.name] = {'bytes': p.stat().st_size, 'sha256': digest.hexdigest()}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'backup': str(root), 'databaseIntegrity': 'ok',
    'files': len(manifest['files']), 'paneCount': len(panes.stdout.splitlines())}))
