import {test,expect} from "@playwright/test";
const origin="http://floor-boards.test:3100";
test("ordinary HTTP loaded floor and wall bundles produce distinct measured synthetic readbacks",async({browser})=>{
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
  const pages=await Promise.all(contexts.map(c=>c.newPage()));
  try{
    const devices=[];
    for(let i=0;i<pages.length;i++){
      await pages[i].goto(`${origin}/?board=caja&readback=1${i?"&wall=1":""}`);
      const id=pages[i].getByTestId("client-instance-id");await expect(id).toHaveText(/^[a-f0-9-]{36}$/);
      devices.push({label:`synthetic-${i}`,role:i?"wall":"floor",origin,clientInstanceId:await id.textContent(),board:"caja",view:i?"wall":"schedule",disposition:"retained"});
    }
    expect(devices[0].clientInstanceId).not.toBe(devices[1].clientInstanceId);
    const owner=await pages[0].evaluate(async()=>{const response=await fetch("/api/managers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"e2e-second-owner"})});return (await response.json()).manager.id as string;});
    const inventory={version:1,synthetic:true,revision:"synthetic-two-browser-profiles",operatorId:owner,enumeratedAt:new Date().toISOString(),devices};
    for(let i=0;i<pages.length;i++){
      const page=pages[i],panel=page.getByTestId("quarter-client-readback");
      await panel.locator('input[type="file"]').setInputFiles({name:"inventory.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(inventory))});
      await panel.getByLabel("Device label").fill(devices[i].label);await panel.locator('input[type="checkbox"]').check();
      await panel.getByRole("button",{name:"Owner sign in"}).click();
      await page.getByTestId("manager-code-input").fill("e2e-second-owner");await page.getByTestId("manager-unlock-submit").click();
      const reply=page.waitForResponse(r=>r.url().endsWith("/api/v2/maintenance/clients")&&r.request().postDataJSON().action==="answer");
      await panel.getByRole("button",{name:"Record readback"}).click();const response=await reply;expect(response.status()).toBe(200);
      const receipt=await response.json();expect(receipt).toMatchObject({synthetic:true,matched:true,label:devices[i].label,measurement:{clientInstanceId:devices[i].clientInstanceId,isSecureContext:false,idbProbe:"commit-readback-ok",legacyBoardCacheAbsent:true,protocol:2,cacheSchema:2,draftDbVersion:1}});
      expect(receipt.measurement.clientBuildSha).toMatch(/^[a-f0-9]{40}$/);expect(receipt.staticSha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(panel.getByRole("status")).toContainText("Readback saved");
      const body=response.request().postDataJSON();
      const status=await page.evaluate(async body=>{
        const login=await fetch("/api/managers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:"e2e-second-owner"})}),session=await login.json();
        return (await fetch("/api/v2/maintenance/clients",{method:"POST",headers:{"Content-Type":"application/json","x-manager-session":session.sessionToken},body:JSON.stringify(body)})).status;
      },body);expect(status).toBe(409);
    }
  }finally{await Promise.all(contexts.map(c=>c.close()));}
});
