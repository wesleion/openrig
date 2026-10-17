import fs from 'node:fs';
import Database from 'better-sqlite3';
const backup='/home/weslei/.openrig/maintenance/20261008-jev-telemetry-backup';
const db=new Database('/home/weslei/.openrig/openrig.sqlite',{readonly:true});
const rigs=['01M42AGNFP7M66S0W2HQG8Z0Q2','01M4BJ5Z3XAS98W160KQ72ZAGK','01M4BXTZ1ZPY04R3F8HS212970'];
const observations=[];
for(let i=0;i<4;i++) {
  if(i) await new Promise(resolve=>setTimeout(resolve,31000));
  const nodes=(await Promise.all(rigs.map(async id=>{
    const response=await fetch('http://127.0.0.1:7433/api/rigs/'+id+'/nodes');
    if(!response.ok)throw Error('Native inventory unavailable: '+response.status);
    return response.json();
  }))).flat().filter(node=>node.runtime==='codex');
  const sample={at:new Date().toISOString(),nodes:nodes.map(node=>({
    nodeId:node.nodeId,seat:node.canonicalSessionName,availability:node.contextUsage?.availability,
    reason:node.contextUsage?.reason,percentage:node.contextUsage?.usedPercentage,
    sampledAt:node.contextUsage?.sampledAt,
    persistedAt:db.prepare('SELECT updated_at FROM context_usage WHERE node_id=?').get(node.nodeId)?.updated_at,
  }))};
  observations.push(sample);
  fs.writeFileSync(backup+'/periodic-metrics.json',JSON.stringify(observations,null,2),{mode:0o600});
  if(nodes.length!==6 || sample.nodes.some(node=>node.availability!=='known'))throw Error('Periodic metrics incomplete.');
  console.log(JSON.stringify({at:sample.at,codexKnown:nodes.length,persistedAt:sample.nodes.map(node=>node.persistedAt)}));
}
for(const node of observations[0].nodes) {
  const writes=new Set(observations.map(sample=>sample.nodes.find(current=>current.nodeId===node.nodeId)?.persistedAt));
  if(writes.size<3)throw Error('Fewer than three observed periodic writes: '+node.seat);
}
console.log('PASS: six Codex remained known across three periodic writes without manual refresh.');
