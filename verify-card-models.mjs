import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {renderGraphStyle} from '/home/weslei/.nvm/versions/node/v24.16.0/lib/node_modules/@openrig/cli/tui/dist/topology/render-graph.js';
const repo=path.dirname(new URL(import.meta.url).pathname);
const backup='/home/weslei/.openrig/maintenance/20261008-jev-telemetry-backup';
const docs='/mnt/c/Users/Weslei/Docs/OpenRig';
const inventory=[];
for(const [name,id] of [['kernel','01M42AGNFP7M66S0W2HQG8Z0Q2'],['openrig-lab','01M4BJ5Z3XAS98W160KQ72ZAGK'],['agency-sites','01M4BXTZ1ZPY04R3F8HS212970']]) {
  const graph=await(await fetch('http://127.0.0.1:7433/api/rigs/'+id+'/graph')).json();
  const lines=renderGraphStyle('hatchet',graph,{host:'local',rig:name},400).plainLines();
  for(const node of graph.nodes.filter(node=>node.type==='rigNode'&&node.data.nodeKind==='agent')) {
    const data=node.data,metadata=data.runtimeMetadata;
    if(data.runtime==='claude-code'&&!metadata?.model)throw Error('Claude model missing: '+data.logicalId);
    if(metadata?.model&&!lines.some(line=>line.includes(`${metadata.model} (${metadata.effort??data.effort??'—'})`)))throw Error('Rendered model/effort missing: '+data.logicalId);
    inventory.push({rig:name,seat:data.canonicalSessionName,logicalId:data.logicalId,metadata});
  }
  fs.writeFileSync(docs+'/ajuste-modelos-20261008-tui-'+name+'.txt',lines.join('\n'));
}
for(const file of ['packages/tui/src/topology/layout.ts','packages/tui/src/topology/styles/hatchet.ts',
  'packages/tui/test/topology-runtime-metadata.test.ts','packages/daemon/src/domain/native-claude-metadata.ts',
  'packages/daemon/src/domain/context-usage-store.ts','packages/daemon/assets/claude-statusline-context.cjs',
  'packages/daemon/test/native-claude-metadata.test.ts','packages/daemon/test/claude-context-collector.test.ts']) {
  const dest=backup+'/source-models/'+file;fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(repo+'/'+file,dest);
}
const artifact=repo+'/.local-packages/openrig-cli-0.6.6.tgz';
fs.copyFileSync(artifact,backup+'/openrig-models-0.6.6.tgz');
fs.copyFileSync('/home/weslei/.openrig/maintenance/current-install.json',backup+'/install-manifest-models.json');
const evidence={at:new Date().toISOString(),inventory,
  tests:{tui:{files:3,passed:44},daemon:{files:4,passed:104},buildExitCode:0},
  artifactSha256:createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),
  acceptance:JSON.parse(fs.readFileSync(backup+'/acceptance.json','utf8'))};
fs.writeFileSync(docs+'/ajuste-modelos-20261008-evidencias.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({rendered:true,agents:inventory.length,claudeModels:inventory.filter(node=>node.metadata?.source?.startsWith('claude')).map(node=>({seat:node.seat,...node.metadata})),artifactSha256:evidence.artifactSha256}));
