import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const repo=path.dirname(new URL(import.meta.url).pathname);
const backup='/home/weslei/.openrig/maintenance/20261008-jev-telemetry-backup';
const docs='/mnt/c/Users/Weslei/Docs/OpenRig';
const env={...process.env,PATH:'/home/weslei/.nvm/versions/node/v24.16.0/bin:'+process.env.PATH};
const artifact=repo+'/.local-packages/openrig-cli-0.6.6.tgz';
const files=['acceptance.json','periodic-metrics.json','compaction-projection.json','tui-agency-sites.txt','tui-jev.txt'];
for(const f of files)fs.copyFileSync(backup+'/'+f,docs+'/upgrade-20261008-'+f);
const source=backup+'/source-final';
for(const workspace of ['daemon','cli','ui','tui'])for(const directory of ['src','test']) {
  const from=repo+'/packages/'+workspace+'/'+directory;
  if(fs.existsSync(from))fs.cpSync(from,source+'/packages/'+workspace+'/'+directory,{recursive:true});
}
fs.cpSync(repo+'/assets',source+'/assets',{recursive:true});
fs.cpSync('/home/weslei/workspaces/openrig-lab/ferramentas/jev-controller/src',source+'/jev/src',{recursive:true});
fs.cpSync('/home/weslei/workspaces/openrig-lab/ferramentas/jev-controller/test',source+'/jev/test',{recursive:true});
fs.writeFileSync(backup+'/source-final-status.txt',execFileSync('git',['status','--short'],{cwd:repo,env,encoding:'utf8'}));
fs.writeFileSync(backup+'/source-final.diff',execFileSync('git',['diff','--binary'],{cwd:repo,env,encoding:'utf8',maxBuffer:20000000}));
fs.copyFileSync(artifact,backup+'/openrig-upgrade-0.6.6.tgz');
fs.copyFileSync('/home/weslei/.openrig/maintenance/current-install.json',backup+'/install-manifest-final.json');
const manifest={at:new Date().toISOString(),source:repo,backup,
  artifactSha256:createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),
  documents:files.map(f=>'upgrade-20261008-'+f),
  validation:{jev:37,tui:873,daemonFocused:517,processCensus:38,verifiedGeneration:1,
    uiFinalFocused:28,controllerAuth:2,controllerBinding:3,cliCompaction:13},
  limitations:['No paid calls or live Claude benchmark.','No live Claude compaction or forced hook reload.','Historical sample freshness preserved.','Three agency Codex seats do not report reasoning effort.']};
fs.writeFileSync(docs+'/upgrade-20261008-manifest.json',JSON.stringify(manifest,null,2));
console.log(JSON.stringify({saved:true,backup,documents:files.length+1,artifactSha256:manifest.artifactSha256}));
