import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function verifyLocalInstallation(home = process.env.HOME) {
  if (!home) throw new Error('HOME is required to verify the OpenRig installation.');
  const manifestPath = path.join(home, '.openrig', 'maintenance', 'current-install.json');
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const changed = [];
  for (const [relative, expected] of Object.entries(manifest.sha256)) {
    const target = path.resolve(manifest.packageRoot, relative);
    if (!target.startsWith(path.resolve(manifest.packageRoot) + path.sep)) throw new Error('Invalid installation manifest path.');
    let actual;
    try { actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex'); } catch { actual = null; }
    if (actual !== expected) changed.push(relative);
  }
  if (changed.length) throw new Error(`OpenRig local corrections were replaced or changed (${changed.join(', ')}). Restore the pinned package ${manifest.artifact} before starting; source and backups: ${manifest.sourceRoot}.`);
}
