import { describe,expect,it } from "vitest";
import { createHash,randomBytes } from "node:crypto";
import { canonicalJson,randomId,sha256 } from "@/lib/quarter/client/primitives";
import { canonical } from "@/lib/quarter/schema";

describe("ordinary HTTP paint primitives",()=>{
  it("matches independent SHA-256 for padding boundaries, UTF-8, long and empty inputs",()=>{
    for(const input of ["","abc","🍳 café 中文",...Array.from({length:140},(_,n)=>"x".repeat(n)),"a".repeat(1000000),randomBytes(2401).toString("hex")]){
      expect(sha256(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
  it("matches server semantic canonical bytes without SubtleCrypto and uses random UUID v4 bits",()=>{
    const value={z:[null,false,2,"café"],a:{b:"x",absent:undefined}};
    expect(canonicalJson(value)).toBe(canonical(value));
    const ids=Array.from({length:50},()=>randomId());
    expect(new Set(ids).size).toBe(50);
    for(const id of ids)expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
});
