import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const base='http://127.0.0.1:7433', rigId='01M4BJ5Z3XAS98W160KQ72ZAGK';
const root='/home/weslei/workspaces/openrig-lab';
const cli=root+'/ferramentas/jev-controller/dist/src/cli.js';
const policy=root+'/ferramentas/jev-controller/policy.json';
const status=()=>JSON.parse(execFileSync(process.execPath,[cli,'status','--config',policy,'--json'],{encoding:'utf8'}));
const before=status();
const mode=execFileSync(process.execPath,[cli,'mode','--set','observe','--config',policy,'--json'],{encoding:'utf8'});
const inventory=await(await fetch(`${base}/api/rigs/${rigId}/nodes`)).json();
if(!inventory.some(n=>n.logicalId==='lab.jev')) {
  const response=await fetch(`${base}/api/rigs/${rigId}/pods/lab/members`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rigRoot:root,
      member:{id:'jev',label:'Controlador Jev',runtime:'terminal',agent_ref:'builtin:terminal',profile:'none',cwd:'.',controller:{kind:'jev-flow',config:'ferramentas/jev-controller/policy.json'}}}),
  });
  const body=await response.json();
  if(!response.ok || body.ok===false) throw Error(`Register failed ${response.status}: ${JSON.stringify(body)}`);
  console.log(JSON.stringify({registered:true,http:response.status}));
}
const after=status();
if(before.attempts!==after.attempts || before.billedMicroUsd!==after.billedMicroUsd || before.committedMicroUsd!==after.committedMicroUsd) throw Error('Ledger usage changed during registration.');
fs.writeFileSync('/home/weslei/.openrig/maintenance/20261008-jev-telemetry-backup/jev-status-registration.json',JSON.stringify({before,after},null,2),{mode:0o600});
console.log(JSON.stringify({mode:after.mode,revision:after.revision,attempts:after.attempts,billedMicroUsd:after.billedMicroUsd}));
