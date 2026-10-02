import { test,expect } from "@playwright/test";

test("prepared Q1 source artifact advertises its exact limits and keeps the hourly board available",async({page,request})=>{
  const response=await request.get("/api/paint/capabilities");expect(response.status()).toBe(200);
  const capabilities=await response.json();
  expect(capabilities).toMatchObject({phase:"prepared",artifactRole:"QP_UI_Q1",activation:false,recovery:false,quarterUi:true,features:{quarterPaint:false,blockNotes:false}});
  expect(capabilities.databaseEpoch).toMatch(/^[a-f0-9-]{36}$/);
  await page.goto("/");await expect(page.getByTestId("floor-board")).toBeVisible();
  const unauthenticated=await request.put("/api/v2/assignments/paint",{data:{protocol:2}});
  expect(unauthenticated.status()).toBe(401);
  const noReceipt=await request.get("/api/v2/assignments/paint/receipts/synthetic-unconfirmed");expect(noReceipt.status()).toBe(401);
});
