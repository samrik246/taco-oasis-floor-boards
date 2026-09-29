import { describe, expect, it } from "vitest";
import { interpretExportLog, kickstartArgs } from "@/lib/wiw-export/kick";
import { WIW_EXPORT_LABEL } from "@/lib/wiw-export/launch-agent";

describe("Importar ahora kick", () => {
  it("names the existing export agent for this user", () => {
    expect(kickstartArgs(501)).toEqual(["kickstart", "-k", `gui/501/${WIW_EXPORT_LABEL}`]);
  });

  it("reads a finished line after the tap and ignores an earlier run", () => {
    const since = Date.parse("2026-09-29T19:00:00.000Z");
    const text = [
      "2026-09-29T18:00:00.000Z wiw-export end exit=0",
      "2026-09-29T19:00:01.000Z wiw-export start week=2026-09-25..2026-10-01",
      "2026-09-29T19:00:40.000Z wiw-export end exit=0 workbook=deleted",
    ].join("\n");
    expect(interpretExportLog(text, since, "es")?.line).toBe("Listo. El horario ya está en el tablero.");
    expect(interpretExportLog(text, since, "en")?.ok).toBe(true);
  });

  it("treats a stop as not done on the board", () => {
    const text = "2026-09-29T19:01:00.000Z wiw-export stop=PAGE reason=DOWNLOAD_NAME\n";
    const result = interpretExportLog(text, Date.parse("2026-09-29T19:00:00.000Z"), "es");
    expect(result?.ok).toBe(false);
    expect(result?.line).toMatch(/se detuvo/);
  });
});
