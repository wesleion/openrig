import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.local-packages');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const log = fs.openSync(path.join(output, 'build.log'), 'w');
const build = spawnSync('/bin/bash', [path.join(root, 'scripts/build-package.sh')], {
  cwd: root, stdio: ['ignore', log, log], timeout: 300_000,
});
fs.closeSync(log);
let packed, artifact;
if (build.status === 0) {
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', output], {
    cwd: path.join(root, 'packages/cli'), encoding: 'utf8', timeout: 120_000,
  });
  if (pack.status === 0) {
    packed = JSON.parse(pack.stdout)[0];
    artifact = path.join(output, packed.filename);
  } else {
    fs.writeFileSync(path.join(output, 'pack-error.log'), pack.stdout + pack.stderr);
  }
}
const result = { buildStatus: build.status, buildError: build.error?.message, artifact,
  packageSize: packed?.size, fileCount: packed?.entryCount };
fs.writeFileSync(path.join(output, 'release-summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exitCode = artifact ? 0 : 1;
