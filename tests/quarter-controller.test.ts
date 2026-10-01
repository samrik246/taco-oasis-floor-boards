import {it,expect} from "vitest";
import {execFileSync} from "node:child_process";
it("runs the complete Python preservation/controller fault package",()=>{
  const output=execFileSync("python3",["tests/quarter_controller_checks.py","-v"],{env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},encoding:"utf8",stdio:"pipe"});
  expect(output).not.toContain("FAILED");
},30000);
