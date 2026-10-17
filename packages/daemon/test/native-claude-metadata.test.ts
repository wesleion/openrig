import {describe,it,expect,beforeEach,afterEach} from "vitest";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {readClaudeRuntimeMetadata} from "../src/domain/native-claude-metadata.js";
import {ContextUsageStore} from "../src/domain/context-usage-store.js";
import {createDb} from "../src/db/connection.js";

describe("Claude native runtime metadata",()=>{
  let dir:string;
  beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),"claude-metadata-"));});
  afterEach(()=>{rmSync(dir,{recursive:true,force:true});});
  const response=(model:string,extra:Record<string,unknown>={})=>({type:"assistant",sessionId:"native-1",timestamp:"2026-10-08T15:00:00Z",message:{role:"assistant",model,content:[{text:"private body"}]},effort:"low",...extra});
  function transcript(rows:unknown[]) {
    const file=join(dir,"session.jsonl");writeFileSync(file,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");return file;
  }
  it("returns only the latest matching real response and its per-turn effort",()=>{
    const file=transcript([response("old"),response("claude-opus-5-5",{perTurnEffort:"high"}),response("<synthetic>"),response("other-account",{sessionId:"other"})]);
    expect(readClaudeRuntimeMetadata(file,"native-1")).toEqual({model:"claude-opus-5-5",effort:"high",sampledAt:"2026-10-08T15:00:00Z",source:"claude_transcript_jsonl"});
  });
  it("never inherits effort from an older response when the latest one omits it",()=>{
    const file=transcript([response("old"),response("new",{effort:null})]);
    expect(readClaudeRuntimeMetadata(file,"native-1")?.effort).toBeNull();
  });
  it("returns unknown for a missing file, absent identity or mismatched session",()=>{
    expect(readClaudeRuntimeMetadata(join(dir,"missing"),"native-1")).toBeNull();
    const file=transcript([response("claude-opus-5-5")]);
    expect(readClaudeRuntimeMetadata(file,null)).toBeNull();
    expect(readClaudeRuntimeMetadata(file,"other")).toBeNull();
  });
  it("bounds its scan and does not revive a response outside the tail",()=>{
    const file=transcript([response("old"),{type:"user",content:"x".repeat(600000)}]);
    expect(readClaudeRuntimeMetadata(file,"native-1")).toBeNull();
  });
  it("populates old sidecars without changing freshness; prefers newer status-line model without mixing effort",()=>{
    const db=createDb();
    try {
      const store=new ContextUsageStore(db,{stateDir:dir});
      const raw={context_window:{used_percentage:12},session_id:"native-1",transcript_path:transcript([response("claude-opus-5-5")]),sampled_at:"2026-01-01T00:00:00Z"};
      const historical=store.normalizeSample(raw);
      expect(historical.runtimeMetadata?.model).toBe("claude-opus-5-5");
      expect(historical.runtimeMetadata?.effort).toBe("low");
      expect(historical.fresh).toBe(false);
      expect(historical.sampledAt).toBe(raw.sampled_at);
      const switched=store.normalizeSample({...raw,model:{id:"claude-sonnet"}});
      expect(switched.runtimeMetadata?.model).toBe("claude-sonnet");
      expect(switched.runtimeMetadata?.effort).toBeNull();
      expect(switched.runtimeMetadata?.source).toBe("claude_statusline_json");
    }finally{db.close();}
  });
});
