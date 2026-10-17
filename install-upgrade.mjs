import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const home='/home/weslei';
const repo=path.dirname(new URL(import.meta.url).pathname);
const root=home+'/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli';
const backup=home+'/.openrig/maintenance/20261008-jev-telemetry-backup';
const env={...process.env,PATH:home+'/.agent-homes/bin:'+home+'/.nvm/versions/node/v24.16.0/bin:'+process.env.PATH}; delete env.OPENRIG_NO_KERNEL;
if(!fs.existsSync(backup+'/openrig.sqlite') || !fs.existsSync(repo+'/packages/cli/daemon/dist/domain/controller-service.js')) throw Error('Backup or compiled release missing.');
for(const pkg of ['daemon','cli','ui','tui']) {
  for(const dir of ['src','test']) if(fs.existsSync(repo+'/packages/'+pkg+'/'+dir)) fs.cpSync(repo+'/packages/'+pkg+'/'+dir,backup+'/source/'+pkg+'/'+dir,{recursive:true});
}
const manifestPath=home+'/.openrig/maintenance/current-install.json';
const previous=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const before=execFileSync('tmux',['list-panes','-a','-F','#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}'],{encoding:'utf8'});
fs.writeFileSync(backup+'/panes-immediately-before.tsv',before);
const cli=args=>execFileSync(process.execPath,[root+'/dist/bin-wrapper.js',...args],{env,encoding:'utf8',timeout:60000,maxBuffer:1000000});
console.log(cli(['daemon','stop']).trim());
for(const dir of ['dist','daemon','ui','tui']) {
  const target=path.resolve(root,dir);
  if(!target.startsWith(root+'/')) throw Error('Unsafe install path');
  const staged=repo+'/packages/cli/'+dir;
  if(!fs.existsSync(staged)) throw Error('Staged component missing: '+dir);
  fs.renameSync(target,backup+'/swapped-'+dir);
  fs.cpSync(staged,target,{recursive:true});
}
const critical=[...Object.keys(previous.sha256),'daemon/dist/domain/controller-service.js','daemon/dist/routes/controllers.js',
  'daemon/dist/domain/context-monitor.js','daemon/dist/domain/context-usage-store.js','daemon/dist/domain/native-codex-observation.js',
  'daemon/dist/domain/claude-compaction-enforcer.js','daemon/dist/domain/session-transport.js','daemon/dist/adapters/claude-compaction-projection.js',
  'tui/dist/runtime-metrics.js','tui/dist/render.js','ui/dist/index.html'];
const sha256=Object.fromEntries([...new Set(critical)].map(p=>[p,createHash('sha256').update(fs.readFileSync(root+'/'+p)).digest('hex')]));
fs.writeFileSync(manifestPath,JSON.stringify({...previous,backup,sha256,upgrade:'jev-telemetry-compaction-20261008'},null,2),{mode:0o600});
console.log(cli(['daemon','start']).trim());
const after=execFileSync('tmux',['list-panes','-a','-F','#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}'],{encoding:'utf8'});
fs.writeFileSync(backup+'/panes-after.tsv',after);
const afterSet=new Set(after.trim().split('\n').map(x=>x.split('\t').slice(0,3).join('\t')));
const missing=before.trim().split('\n').filter(x=>!afterSet.has(x.split('\t').slice(0,3).join('\t')));
if(missing.length) throw Error('Existing pane identity changed; inspect saved pane snapshots.');
console.log(JSON.stringify({installed:true,existingPanesPreserved:before.trim().split('\n').length,backup}));
