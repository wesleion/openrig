import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const [home, backup] = process.argv.slice(2);
if (!home || !backup) throw new Error('Usage: local-kernel-role-upgrade.mjs <home> <private-backup-directory>');
const db = new Database(path.join(home, '.openrig', 'openrig.sqlite'), { fileMustExist: true });
const roles = new Set(['advisor.lead', 'operator.agent', 'queue.worker']);
const rows = db.prepare("SELECT n.logical_id, s.node_id, s.projection_entries_json FROM nodes n JOIN rigs r ON r.id=n.rig_id JOIN node_startup_context s ON s.node_id=n.id WHERE r.name='kernel'").all().filter(row => roles.has(row.logical_id));
const edits = [];
for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
  const target = path.join(home, '.openrig', 'workspace', filename);
  if (!fs.existsSync(target)) continue;
  const before = fs.readFileSync(target, 'utf8');
  const after = before.replace(/<!-- BEGIN (OpenRig|RIGGED) MANAGED BLOCK: role -->([\s\S]*?)<!-- END \1 MANAGED BLOCK: role -->/g, (block, _marker, body) => {
    if (!/^# (Queue Worker|Operator Agent|Advisor Lead) — Role(?:\r?\n|$)/.test(body.trim())) throw new Error(`Role block ownership is uncertain: ${target}`);
    return '';
  });
  if (before !== after) edits.push({ target, filename, before, after });
}
// The deployment procedure stops only the daemon before invoking this script.
// No queue item, conversation, account, permission or native pane is changed.
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(backup, 'kernel-startup-context-before.json'), JSON.stringify(rows), { mode: 0o600 });
for (const edit of edits) fs.writeFileSync(path.join(backup, 'kernel-' + edit.filename), edit.before, { mode: 0o600 });
let changed = 0;
db.transaction(() => {
  for (const row of rows) {
    const before = JSON.parse(row.projection_entries_json);
    const after = before.filter(entry => !(entry.category === 'guidance' && entry.effectiveId === 'role' && entry.mergeStrategy === 'managed_block'));
    if (after.length !== before.length) { db.prepare('UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?').run(JSON.stringify(after), row.node_id); changed++; }
  }
})();
for (const edit of edits) fs.writeFileSync(edit.target, edit.after);
db.close();
console.log(JSON.stringify({ updatedStartupContexts: changed, removedOwnedRoleBlocks: edits.length }));
