import {afterEach,beforeEach,expect,it,vi} from "vitest";
const f=vi.hoisted(()=>({db:{},attest:vi.fn(),compatible:vi.fn(),timer:vi.fn()}));
vi.mock("@/lib/db",()=>({prisma:f.db}));
vi.mock("@/lib/quarter/service-startup",()=>({attestServiceStartup:f.attest}));
vi.mock("@/lib/quarter/compatibility",()=>({assertRuntimeCompatibility:f.compatible}));
vi.mock("@/lib/breaks/auto-pick",()=>({startBreakPickTimer:f.timer}));
import {register} from "../src/instrumentation";
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("NEXT_RUNTIME","nodejs");});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
it("does not register a picker while startup attestation is pending or after refusal",async()=>{
 let finish:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{finish=resolve;});
 f.attest.mockImplementation(async(_db,compatible:()=>Promise<void>)=>{await gate;await compatible();});
 f.compatible.mockRejectedValue(new Error("QUARTER_SCHEMA_INCOMPATIBLE"));
 const result=register();await vi.waitFor(()=>expect(f.attest).toHaveBeenCalledOnce());
 expect(f.timer).not.toHaveBeenCalled();finish();await expect(result).rejects.toThrow("QUARTER_SCHEMA_INCOMPATIBLE");
 expect(f.timer).not.toHaveBeenCalled();
});
it("registers only after attestation and skips the edge runtime",async()=>{
 const order:string[]=[];
 f.attest.mockImplementation(async(_db,compatible:()=>Promise<void>)=>{order.push("attest");await compatible();order.push("ready");});
 f.compatible.mockImplementation(async()=>{order.push("compatible");});f.timer.mockImplementation(()=>{order.push("timer");});
 await register();expect(order).toEqual(["attest","compatible","ready","timer"]);
 vi.stubEnv("NEXT_RUNTIME","edge");await register();expect(f.attest).toHaveBeenCalledOnce();expect(f.timer).toHaveBeenCalledOnce();
});
it("the actual picker creates no timer in the disposable harness",async()=>{
 expect(process.env.FLOOR_BOARDS_TEST_ROOT).toBeTruthy();
 const timer=vi.spyOn(globalThis,"setInterval");
 const actual=await vi.importActual<typeof import("@/lib/breaks/auto-pick")>("@/lib/breaks/auto-pick");
 actual.startBreakPickTimer();actual.startBreakPickTimer();expect(timer).not.toHaveBeenCalled();
});
