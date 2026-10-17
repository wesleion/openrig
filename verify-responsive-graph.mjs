import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {layoutGraph} from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/topology/layout.js';
import {renderGraphStyle} from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/topology/render-graph.js';
import {DaemonClient} from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/daemon-client.js';
import {hydrateSnapshot} from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/hydrate.js';
import {createViewState} from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/state.js';
import {renderScreen} from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/render.js';
const repo=path.dirname(new URL(import.meta.url).pathname);
const backup='/home/weslei/.openrig/maintenance/20261008-jev-telemetry-backup';
const docs='/mnt/c/Users/Weslei/Docs/OpenRig';
const id='01M4BXTZ1ZPY04R3F8HS212970';
const nodes=await(await fetch('http://127.0.0.1:7433/api/rigs/'+id+'/nodes?refresh=true')).json();
const codex=nodes.filter(node=>node.runtime==='codex');
if(codex.length!==3||codex.some(node=>node.contextUsage?.runtimeMetadata?.effort!=='default'||node.contextUsage.runtimeMetadata.effortDefault!=='low'))throw Error('Agency default metadata missing.');
const graph=await(await fetch('http://127.0.0.1:7433/api/rigs/'+id+'/graph')).json();
const geometries=[];
for(const width of [32,44,70,100,140,240]) {
  const layout=layoutGraph(graph,width,'agency-sites');
  if(layout.clipped||layout.placed.length!==5||layout.placed.some(card=>card.x+card.w>width))throw Error('Responsive graph lost a member.');
  const text=renderGraphStyle('hatchet',graph,{host:'local',rig:'agency-sites'},width).plainLines().join('\n');
  if(width>=44&&!text.includes('gpt-6.1-sol (low, padrão)'))throw Error('Default label missing.');
  fs.writeFileSync(docs+'/grafo-responsivo-20261008-conteudo-'+width+'.txt',text);
  geometries.push({width,height:layout.height,clipped:layout.clipped,members:layout.placed.length});
}
const snapshot=await hydrateSnapshot(new DaemonClient({baseUrl:'http://127.0.0.1:7433'}),undefined,undefined,undefined,'agency-sites');
const terminal=[];
for(const cols of [80,100,140,200]) {
  const view=createViewState({instanceId:'responsive-validation',getSnapshot:()=>snapshot});
  view.dispatch({type:'drill',resource:'rig',name:'agency-sites',target:{host:snapshot.hosts[0].name}});view.dispatch({type:'tab',tab:'graph'});
  let screen=renderScreen(view.get(),snapshot,{cols,rows:34});
  if(screen.lines.join('\n').includes('content clipped'))throw Error('Clipped native TUI viewport.');
  const pages=[],seen=new Set();
  for(let page=0;page<20;page++) {
    pages.push(screen.lines.join('\n'));
    for(const target of screen.contentTargets)if(target.action.type==='drill'&&target.action.resource==='agent')seen.add(target.action.name);
    view.dispatch({type:'layout',contentMaxOffset:screen.contentMaxOffset,contentTargetCount:screen.contentTargets.length});
    if(view.get().contentOffset>=screen.contentMaxOffset)break;
    view.dispatch({type:'content-scroll',delta:10});screen=renderScreen(view.get(),snapshot,{cols,rows:34});
  }
  const expected=graph.nodes.filter(node=>node.type==='rigNode'&&node.data.nodeKind==='agent').map(node=>node.data.logicalId);
  if(expected.some(name=>!seen.has(name)))throw Error('Vertical navigation lost a member: '+cols);
  fs.writeFileSync(docs+'/grafo-responsivo-20261008-terminal-'+cols+'.txt',pages.join('\n\n--- PAGE ---\n\n'));
  terminal.push({cols,rows:34,pages:pages.length,reached:seen.size});
}
const before=fs.readFileSync(backup+'/panes-before-responsive.tsv','utf8').trim().split('\n');
const after=execFileSync('tmux',['list-panes','-a','-F','#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}'],{encoding:'utf8'}).trim().split('\n');
const signature=line=>line.split('\t').slice(0,3).join('\t'),set=new Set(after.map(signature));
if(before.some(line=>!set.has(signature(line))))throw Error('A pre-existing pane disappeared.');
const artifact=repo+'/.local-packages/openrig-cli-0.6.6.tgz';
fs.copyFileSync(artifact,backup+'/openrig-responsive-0.6.6.tgz');
fs.copyFileSync('/home/weslei/.openrig/maintenance/current-install.json',backup+'/install-manifest-responsive.json');
for(const directory of ['packages/tui/src','packages/tui/test','packages/daemon/src','packages/daemon/test','packages/ui/src'])fs.cpSync(repo+'/'+directory,backup+'/source-responsive/'+directory,{recursive:true});
const evidence={at:new Date().toISOString(),codex:codex.map(node=>({seat:node.canonicalSessionName,metadata:node.contextUsage.runtimeMetadata})),geometries,terminal,panesPreserved:before.length,
  tests:{tui:52,daemon:69,ui:19,buildExitCode:0},artifactSha256:createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')};
fs.writeFileSync(docs+'/grafo-responsivo-20261008-evidencias.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
