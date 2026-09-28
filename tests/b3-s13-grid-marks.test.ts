/**
 * B3 S13: Habilidades cells use the S12 mark tokens. Headers and column defaults stay put.
 */
import { describe, expect, it } from "vitest";
import { stationColorClass } from "@/components/board/board-helpers";
import { stationSolidClass } from "@/lib/schedule/station-codes";
import { gridCellMarkClass, markBorderClass, markFillClass } from "@/lib/selection-mark";

const COLORS = [
  "pink",
  "green",
  "yellow",
  "purple",
  "lime",
  "blue",
  "lavender",
  "gray",
  "teal",
  "orange",
  "cyan",
  "red",
  "brown",
  "maroon",
];

describe("B3 S13 grid marks", () => {
  it("maps no, poco, bien, and fuerte onto the SelectionMarkDot tokens", () => {
    for (const color of COLORS) {
      const plain = gridCellMarkClass("forbidden", color);
      const dashed = gridCellMarkClass("training", color);
      const solid = gridCellMarkClass("ok", color);
      const filled = gridCellMarkClass("preferred", color);
      const painted = stationColorClass(color);
      const solidPaint = stationSolidClass(color);

      expect(plain.mark).toBe("none");
      expect(plain.className).toContain("bg-white");
      expect(plain.className).toContain("border-neutral-300");
      expect(plain.className).not.toContain("border-dashed");

      expect(dashed.mark).toBe("dashed");
      expect(dashed.className).toContain("border-dashed");
      expect(dashed.className).toContain(markBorderClass(color));
      expect(dashed.className).toContain("bg-white");
      expect(dashed.className).not.toContain(markFillClass(color));

      expect(solid.mark).toBe("solid");
      expect(solid.className).toContain("border-solid");
      expect(solid.className).toContain(markBorderClass(color));
      expect(solid.className).toContain("bg-white");
      expect(solid.className).not.toContain(markFillClass(color));

      expect(filled.mark).toBe("filled");
      expect(filled.className).toContain("border-solid");
      expect(filled.className).toContain(markBorderClass(color));
      expect(filled.className).toContain(markFillClass(color));
      expect(filled.className).not.toContain("bg-white");

      for (const frame of [plain, dashed, solid, filled]) {
        expect(frame.className).not.toContain(painted);
        expect(frame.className).not.toContain(solidPaint);
      }
    }
    expect(gridCellMarkClass("mixed", "orange").mark).toBe("none");
    expect(gridCellMarkClass("preferred", "yellow").className).toContain("text-neutral-950");
    expect(gridCellMarkClass("preferred", "orange").className).toContain("text-neutral-950");
    expect(gridCellMarkClass("preferred", "pink").className).toContain("text-white");
  });
});
