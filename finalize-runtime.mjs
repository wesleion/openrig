import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyLocalInstallation } from './scripts/local-install-guard.mjs';
const home='/home/weslei',repo=path.dirname(new URL(import.meta.url).pathname);
const root=home+'/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli';
const backup=home+'/.openrig/maintenance/20261008-jev-telemetry-backup';
const manifestPath=home+'/.openrig/maintenance/current-install.json';
verifyLocalInstallation(home);
fs.writeFileSync(backup+'/panes-before-responsive.tsv',execFileSync('tmux',['list-panes','-a','-F','#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}'],{encoding:'utf8'}));
fs.copyFileSync(manifestPath,backup+'/prior-install-manifest-'+Date.now()+'.json');
const env={...process.env,PATH:home+'/.agent-homes/bin:'+home+'/.nvm/versions/node/v24.16.0/bin:'+process.env.PATH};delete env.OPENRIG_NO_KERNEL;
const cli=args=>execFileSync(process.execPath,[root+'/dist/bin-wrapper.js',...args],{env,encoding:'utf8',timeout:60000,maxBuffer:1000000});
console.log(cli(['daemon','stop']).trim());
for(const dir of ['dist','daemon','ui','tui']) {
  const target=path.resolve(root,dir),staged=repo+'/packages/cli/'+dir;
  if(!target.startsWith(root+'/')||!fs.existsSync(staged))throw Error('Invalid runtime component');
  const old=backup+'/prior-final-'+dir+'-'+Date.now();fs.renameSync(target,old);fs.cpSync(staged,target,{recursive:true});
}
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
for(const file of ['daemon/dist/domain/native-claude-metadata.js','daemon/assets/claude-statusline-context.cjs','tui/dist/topology/layout.js','tui/dist/topology/styles/hatchet.js','tui/dist/topology/styles/braille.js'])manifest.sha256[file]='';
for(const p of Object.keys(manifest.sha256))manifest.sha256[p]=createHash('sha256').update(fs.readFileSync(root+'/'+p)).digest('hex');
fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});
console.log(cli(['daemon','start']).trim());
console.log(JSON.stringify({updated:true,backup}));
