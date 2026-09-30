/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayDayList } from "@/components/board/OverlayDayList";
import type { DayBoardDto } from "@/components/board/types";
import type { OverlayDto } from "@/lib/overlays/read";
import { chicagoDateTime } from "@/lib/time";

const date = "2036-06-16";

function row(id: string, endReason: "cancel" | "import"): OverlayDto {
  return {
    id,
    kind: "switch",
    employeeId: "ada",
    partnerEmployeeId: "cam",
    stationId: "multi",
    fromStationId: "green1",
    startAt: chicagoDateTime(date, "1:00 pm").toISOString(),
    endAt: chicagoDateTime(date, "1:15 pm").toISOString(),
    managerId: "mgr",
    managerName: "Gerente",
    cancelledAt: chicagoDateTime(date, "1:05 pm").toISOString(),
    endReason,
  };
}

function day(overlays: OverlayDto[]): DayBoardDto {
  return {
    board: "caja",
    date,
    stations: [],
    shifts: [{
      id: "ada-shift",
      date,
      startAt: chicagoDateTime(date, "11:00 am").toISOString(),
      endAt: chicagoDateTime(date, "4:00 pm").toISOString(),
      sourcePosition: "Caja",
      board: "caja",
      employee: { id: "ada", firstName: "Ada", lastName: "Moss", email: null },
      assignments: [],
    }],
    overlays,
    overlayMenu: true,
  };
}

async function render(locale: "es" | "en") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(OverlayDayList, {
      day: day([row("imp", "import"), row("can", "cancel")]),
      board: "caja",
      date,
      locale,
      managerToken: "tok",
      onSaved: async () => {},
    }));
  });
  return { host, root };
}

describe("overlay day list labels", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows Importación for an import end and Cancelado for a cancel", async () => {
    const spanish = await render("es");
    const imported = spanish.host.querySelector("[data-testid=overlay-row-imp]")?.textContent ?? "";
    expect(imported).toContain("Importación");
    expect(imported).not.toContain("Cancelado");
    expect(spanish.host.querySelector("[data-testid=overlay-row-can]")?.textContent).toContain("Cancelado");
    spanish.root.unmount();

    const english = await render("en");
    const importedEnglish = english.host.querySelector("[data-testid=overlay-row-imp]")?.textContent ?? "";
    expect(importedEnglish).toContain("Import");
    expect(importedEnglish).not.toContain("Cancelled");
    expect(english.host.querySelector("[data-testid=overlay-row-can]")?.textContent).toContain("Cancelled");
    english.root.unmount();
  });
});
