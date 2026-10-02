import {it,expect} from "vitest";
import {execFileSync} from "node:child_process";
it("refuses self evidence and incomplete actual-Q1 qualification records",()=>{
  execFileSync("python3",["tests/quarter_q1_checks.py","-v"],{env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},encoding:"utf8",stdio:"pipe"});
},30000);
it("runs the complete Python preservation/controller fault package",()=>{
  const output=execFileSync("python3",["tests/quarter_controller_checks.py","-v"],{env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},encoding:"utf8",stdio:"pipe"});
  expect(output).not.toContain("FAILED");
},30000);

it("runs the complete Python legacy editor package, including active-schema refusal",()=>{
  const output=execFileSync("python3",["tests/test_edit_board.py","-v"],{env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},encoding:"utf8",stdio:"pipe"});
  expect(output).not.toContain("FAILED");
},30000);

it("runs the complete managed-service identity and cleanup fault package",()=>{
  const output=execFileSync("python3",["tests/quarter_managed_service_checks.py","-v"],{env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},encoding:"utf8",stdio:"pipe"});
  expect(output).not.toContain("FAILED");
},30000);
