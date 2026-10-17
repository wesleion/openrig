import {it,expect}from'vitest';
import {spawn}from'node:child_process';
import fs from'node:fs';
import {closeVacantShell}from'../src/domain/provider/native-account-session.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
it('preserves a shell while its child runs and closes only the vacant process',async()=>{
 const shell=spawn('/bin/bash',['--noprofile','--norc','-i'],{stdio:['pipe','ignore','ignore']});
 const pid=shell.pid!;const exited=new Promise(r=>shell.once('exit',r));
 try{
  shell.stdin.write('sleep 0.3 & wait\n');
  let children='';for(let i=0;i<50;i++){await delay(10);children=fs.readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim();if(children)break;}
  expect(children).not.toBe('');expect(closeVacantShell(pid)).toBe(false);
  for(let i=0;i<100;i++){await delay(10);children=fs.readFileSync(`/proc/${pid}/task/${pid}/children`,'utf8').trim();if(!children)break;}
  expect(children).toBe('');expect(closeVacantShell(pid)).toBe(true);
  await Promise.race([exited,delay(1000).then(()=>{throw Error('vacant shell did not exit');})]);
 }finally{shell.kill('SIGKILL');}
});
