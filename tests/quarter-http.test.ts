import { afterEach,describe,expect,it,vi } from "vitest";
import { NextResponse } from "next/server";
const mocks=vi.hoisted(()=>({auth:vi.fn(),access:vi.fn(),write:vi.fn(),receipt:vi.fn(),mutations:vi.fn()}));
vi.mock("@/lib/managers/require-session",()=>({requireManagerSession:mocks.auth}));
vi.mock("@/lib/managers/day-access",()=>({requireDayAccess:mocks.access}));
vi.mock("@/lib/db",()=>({prisma:{$queryRawUnsafe:mocks.mutations}}));
vi.mock("@/lib/quarter/transaction",()=>({paintV2:mocks.write,receiptFor:mocks.receipt}));
import { PUT } from "@/app/api/v2/assignments/paint/route";
import { GET } from "@/app/api/v2/assignments/paint/receipts/[requestId]/route";
import { QuarterRefused } from "@/lib/quarter/schema";
import { quarterBody,quarterError } from "@/lib/quarter/http";
import { QUARTER_MEDIA_TYPE } from "@/lib/quarter/protocol";
const headers={"x-floor-boards-protocol":"2","content-type":QUARTER_MEDIA_TYPE};
const params={params:Promise.resolve({requestId:"synthetic"})};
afterEach(()=>vi.resetAllMocks());
describe("quarter HTTP protocol and receipt authority",()=>{
  it("authenticates before parsing a body or looking up receipts",async()=>{
    mocks.auth.mockResolvedValue({ok:false,response:NextResponse.json({error:"Unauthorized"},{status:401})});
    expect((await PUT(new Request("http://local/api/v2/assignments/paint",{method:"PUT",body:"not json"}))).status).toBe(401);
    expect((await GET(new Request("http://local/receipt"),params)).status).toBe(401);
    expect(mocks.write).not.toHaveBeenCalled();expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it("never accepts V2 data in ordinary hourly media or without the explicit protocol",async()=>{
    await expect(quarterBody(new Request("http://local/write",{method:"POST",headers:{"content-type":"application/json"},body:'{"protocol":2}'}))).rejects.toMatchObject({code:"UNSUPPORTED_PROTOCOL"});
    await expect(quarterBody(new Request("http://local/write",{method:"POST",headers,body:"x".repeat(2*1024*1024+1)}))).rejects.toMatchObject({code:"REQUEST_TOO_LARGE"});
  });
  it("authenticated over-limit input refuses before date reads or writes",async()=>{
    mocks.auth.mockResolvedValue({ok:true,manager:{id:"manager-a",name:"Synthetic"}});
    const response=await PUT(new Request("http://local/api/v2/assignments/paint",{method:"PUT",headers,body:JSON.stringify({intents:Array(2001).fill({})})}));
    expect(response.status).toBe(413);expect(mocks.write).not.toHaveBeenCalled();expect(mocks.access).not.toHaveBeenCalled();
  });
  it("binds receipt lookup to the current manager and rechecks every original date",async()=>{
    mocks.auth.mockResolvedValue({ok:true,manager:{id:"manager-a",name:"Synthetic"}});
    mocks.receipt.mockResolvedValue({responseJson:JSON.stringify({dates:["2038-10-12","2038-10-13"],ok:true,privateSentinel:"never-disclose"})});
    mocks.mutations.mockResolvedValue([]);
    mocks.access.mockResolvedValueOnce({ok:true}).mockResolvedValueOnce({ok:false,response:NextResponse.json({error:"Not permitted"},{status:403})});
    const request=new Request("http://local/receipt");const response=await GET(request,params);
    expect(mocks.receipt).toHaveBeenCalledWith(expect.anything(),"manager-a","synthetic");
    expect(mocks.access.mock.calls.map(c=>c[1])).toEqual(["2038-10-12","2038-10-13"]);
    expect(response.status).toBe(403);expect(await response.text()).not.toContain("never-disclose");
  });
  it("conflict responses preserve exact interval details for the painter",async()=>{
    const conflicts=[{shiftId:"source",startAt:"2038-10-12T18:00:00.000Z",endAt:"2038-10-12T18:30:00.000Z",reason:"MIXED_BASE"}];
    const response=quarterError(new QuarterRefused("HOUR_NEEDS_QUARTER",409,{conflicts}));
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:"HOUR_NEEDS_QUARTER",draftRetained:true,conflicts});
  });
  it("an unscoped or missing receipt is unconfirmed, never blanket saved",async()=>{
    mocks.auth.mockResolvedValue({ok:true,manager:{id:"manager-a",name:"Synthetic"}});
    mocks.receipt.mockResolvedValueOnce(null).mockResolvedValueOnce({responseJson:"{}"});mocks.mutations.mockResolvedValue([]);
    expect((await GET(new Request("http://local/receipt"),params)).status).toBe(404);
    expect((await GET(new Request("http://local/receipt"),params)).status).toBe(409);
  });
});
