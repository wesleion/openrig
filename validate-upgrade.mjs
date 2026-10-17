import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DaemonClient } from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/daemon-client.js';
import { hydrateSnapshot } from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/hydrate.js';
import { createViewState } from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/state.js';
import { renderScreen } from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/render.js';
import { stateWithElapsed } from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/runtime-metrics.js';
const home='/home/weslei', backup=home+'/.openrig/maintenance/20261008-jev-telemetry-backup';
const client=new DaemonClient({baseUrl:'http://127.0.0.1:7433'});
const snapshot=await hydrateSnapshot(client);
const local=snapshot.hosts[0];
const agents=local.rigs.flatMap(r=>r.pods.flatMap(p=>p.agents));
const codex=agents.filter(a=>a.runtime==='codex');
if(codex.length!==6 || codex.some(a=>a.contextUsage?.availability!=='known')) throw Error('Codex live metrics incomplete.');
const tool=agents.find(a=>a.controller?.kind==='jev-flow');
if(!tool || tool.nodeKind!=='infrastructure' || tool.controller.mode!=='observe')throw Error('Controller projection invalid.');
const now=Date.now(), row=codex.find(a=>a.name.includes('builder'));
const first=stateWithElapsed(row,'idle',now,20),second=stateWithElapsed(row,'idle',now+60000,20);
if(first===second)throw Error('Idle duration does not advance.');
const view=createViewState({instanceId:'upgrade-validation',getSnapshot:()=>snapshot});
view.dispatch({type:'drill',resource:'rig',name:'agency-sites',target:{host:local.name}});
const table=renderScreen(view.get(),snapshot,{cols:180,rows:65,nowMs:now});
fs.writeFileSync(backup+'/tui-agency-sites.txt',table.lines.join('\n'));
view.dispatch({type:'drill',resource:'agent',name:tool.name,target:{host:local.name,rig:'openrig-lab',pod:'lab'}});
const detail=renderScreen(view.get(),snapshot,{cols:180,rows:80,nowMs:now});
const actions=detail.hitMap.map(h=>h.action).filter(a=>a.type==='act'&&a.act==='controller-mode');
if(actions.length!==3)throw Error('TUI controller actions missing.');
fs.writeFileSync(backup+'/tui-jev.txt',detail.lines.join('\n'));
const same=await client.setControllerMode(tool.rigId,tool.nodeId,'observe',tool.controller.revision);
if(same.mode!=='observe')throw Error('TUI HTTP contract invalid.');
const before=fs.readFileSync(backup+'/panes-immediately-before.tsv','utf8').trim().split('\n');
const after=execFileSync('tmux',['list-panes','-a','-F','#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}'],{encoding:'utf8'}).trim().split('\n');
const signature=line=>line.split('\t').slice(0,3).join('\t'),set=new Set(after.map(signature));
if(before.some(line=>!set.has(signature(line))))throw Error('Original pane identity missing.');
const pkg=home+'/workspaces/openrig-lab/ferramentas/jev-controller';
const ledger=JSON.parse(execFileSync(process.execPath,[pkg+'/dist/src/cli.js','status','--config',pkg+'/policy.json','--json'],{encoding:'utf8'}));
const registered=JSON.parse(fs.readFileSync(backup+'/jev-status-registration.json','utf8')).before;
if(ledger.attempts!==registered.attempts || ledger.billedMicroUsd!==registered.billedMicroUsd)throw Error('Paid usage changed.');
const evidence={daemon:await(await fetch('http://127.0.0.1:7433/healthz')).json(),
  controller:same,originalPanesPreserved:before.length,totalPanes:after.length,clock:{first,second},
  codex:codex.map(a=>({seat:a.name,context:a.context,model:a.runtimeMetadata,usage:a.contextUsage})),
  ledger:{attempts:ledger.attempts,billedMicroUsd:ledger.billedMicroUsd,modelApplyEnabled:ledger.modelApplyEnabled},
  tui:{modeActions:actions.length,runtimeClockActive:table.runtimeClockActive},readErrors:snapshot.readErrors};
fs.writeFileSync(backup+'/acceptance.json',JSON.stringify(evidence,null,2),{mode:0o600});
console.log(JSON.stringify({codexKnown:codex.length,controllerMode:same.mode,originalPanesPreserved:before.length,totalPanes:after.length,clock:{first,second},tuiActions:actions.length,ledger:evidence.ledger,readErrors:snapshot.readErrors}));
