import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { reconcileClaudeCompactionProjection, isCanonicalClaudeCompactionPlugin } from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/daemon/dist/adapters/claude-compaction-projection.js';
const repo=path.dirname(new URL(import.meta.url).pathname), home='/home/weslei';
const require=createRequire(repo+'/packages/daemon/package.json');
const db=new(require('better-sqlite3'))(home+'/.openrig/openrig.sqlite',{readonly:true});
const rows=db.prepare("SELECT n.cwd,c.projection_entries_json FROM nodes n JOIN node_startup_context c ON c.node_id=n.id JOIN rigs r ON r.id=n.rig_id WHERE n.runtime='claude-code' AND r.archived_at IS NULL").all();db.close();
const ops={exists:fs.existsSync,readFile:p=>fs.readFileSync(p,'utf8'),writeFile:(p,s)=>fs.writeFileSync(p,s),mkdirp:p=>fs.mkdirSync(p,{recursive:true}),
  statMode:p=>fs.statSync(p).mode,chmod:fs.chmodSync,inspectPath:p=>{try {const s=fs.lstatSync(p);return s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':s.isFile()?'file':'other';}catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))return 'missing';throw e;}},
  listFiles:p=>{const out=[];const walk=(dir,relative='')=>{for(const x of fs.readdirSync(dir,{withFileTypes:true})){const rel=path.join(relative,x.name);if(x.isSymbolicLink())throw Error('Source symlink refused');if(x.isDirectory())walk(path.join(dir,x.name),rel);else if(x.isFile())out.push(rel);}};walk(p);return out;}};
const seen=new Set(),results=[];
for(const row of rows) {
  for(const plugin of JSON.parse(row.projection_entries_json).filter(x=>x.category==='plugin')) {
    const key=row.cwd+'|'+plugin.absolutePath;if(seen.has(key))continue;seen.add(key);
    if(!isCanonicalClaudeCompactionPlugin(ops,plugin.absolutePath))continue;
    const dir=home+'/.openrig/maintenance/20261008-jev-telemetry-backup/compaction/'+results.length;
    fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(dir+'/cwd.txt',row.cwd);
    for(const rel of ['.claude/settings.local.json','.claude/skills/claude-compaction-restore','.openrig/hooks/compaction-assets.json','.openrig/hooks/scripts/compaction-restore-bridge.cjs'])
      if(fs.existsSync(path.join(row.cwd,rel))){const dest=path.join(dir,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(path.join(row.cwd,rel),dest,{recursive:true,dereference:false});}
    const result=reconcileClaudeCompactionProjection({fs:ops,cwd:row.cwd,pluginPath:plugin.absolutePath});
    results.push({cwd:row.cwd,...result});
  }
}
fs.writeFileSync(home+'/.openrig/maintenance/20261008-jev-telemetry-backup/compaction-projection.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(x=>({cwd:x.cwd,delivered:x.delivered,changed:x.changed,warnings:x.warnings}))));
