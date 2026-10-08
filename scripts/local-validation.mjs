import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [workspace, label, ...files] = process.argv.slice(2);
if (!['daemon', 'cli', 'tui', 'ui'].includes(workspace) || !/^[a-z0-9_-]+$/.test(label ?? '')) throw new Error('Invalid validation target');
const output = path.join(root, '.local-validation'); fs.mkdirSync(output, { recursive: true });
const reportPath = path.join(output, label + '.json');
const logPath = path.join(output, label + '.log');
const log = fs.openSync(logPath, 'w');
const result = spawnSync(path.join(root, 'node_modules', '.bin', 'vitest'), ['run', ...files, '--maxWorkers', '4', '--reporter', 'json', '--outputFile', reportPath], {
  cwd: path.join(root, 'packages', workspace), timeout: 650_000, stdio: ['ignore', log, log],
});
fs.closeSync(log);
let report;
try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* incomplete runs are reported explicitly */ }
const summary = { workspace, status: result.status, error: result.error?.message, total: report?.numTotalTests,
  passed: report?.numPassedTests, failed: report?.numFailedTests, pending: report?.numPendingTests,
  failures: report?.testResults.flatMap(s => s.assertionResults.filter(t => t.status === 'failed').map(t => ({ file: path.basename(s.name), name: t.fullName, error: t.failureMessages.join(' ').slice(0,1000) }))) };
fs.writeFileSync(path.join(output, label + '.summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, failures: summary.failures?.slice(0,5) }));
process.exitCode = result.status ?? 1;
