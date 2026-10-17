import { it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";

it("verified resumed thread retains historical context without pretending freshness; successor rejects it", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"verified-context-"));
  const db=createDb();migrate(db,ALL_MIGRATIONS);
  const repo=new RigRepository(db);const rig=repo.createRig("lab");const node=repo.addNode(rig.id,"lab.codex",{runtime:"codex"});
  const rollout=path.join(root,"rollout.jsonl"), old="2026-10-06T05:35:07Z";
  const native=new BetterSqlite3(path.join(root,"state_5.sqlite"));
  native.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL)");native.prepare("INSERT INTO threads VALUES(?,?)").run("current-thread",rollout);native.close();
  fs.writeFileSync(rollout,JSON.stringify({timestamp:old,type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:120,output_tokens:3,cached_input_tokens:100,total_tokens:123},model_context_window:1000}}})+"\n");
  let generation="current-generation";
  const store=new ContextUsageStore(db,{stateDir:root,resolveOccupantBootAt:()=>"2026-10-07T11:50:01Z",resolveOccupantGeneration:()=>generation});
  try {
    const unverified=store.readCodexAndNormalize({threadId:"current-thread",sessionName:"lab-codex@lab",codexHome:root});
    store.persist(node.id,unverified);expect(store.getForNode(node.id,"lab-codex@lab").reason).toBe("stale_generation");
    const verified=store.readCodexAndNormalize({threadId:"current-thread",sessionName:"lab-codex@lab",codexHome:root,verifiedGeneration:generation});
    store.persist(node.id,verified);
    const projected=store.getForNode(node.id,"lab-codex@lab");expect(projected.availability).toBe("known");expect(projected.sampledAt).toBe(old);expect(projected.fresh).toBe(false);
    expect(store.getForNodes([{nodeId:node.id,currentSessionName:"lab-codex@lab"}]).get(node.id)?.availability).toBe("known");
    generation="successor-generation";
    expect(store.getForNode(node.id,"lab-codex@lab").reason).toBe("stale_generation");
    expect(store.getForNodes([{nodeId:node.id,currentSessionName:"lab-codex@lab"}]).get(node.id)?.reason).toBe("stale_generation");
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});
