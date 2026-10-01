/** @vitest-environment jsdom */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportPreviewModal, type ImportPreviewData } from "@/components/board/ImportPreviewModal";
import { ReturnPromptBanner } from "@/components/board/ReturnPromptBanner";
import { messagesFor } from "@/lib/i18n";

describe("whole-version saved station labels", () => {
  it.each(["es", "en"] as const)("%s import changes and return prompts preserve saved overrides", locale => {
    const stations = [{ id: "yellow", label: "Synthetic custom corner" }];
    const preview: ImportPreviewData = { fingerprint: "synthetic", planDigest: "synthetic", needsConfirm: true, refusals: [], stations,
      dates: [{ date: "2040-06-06", added: 0, changed: 1, replaced: 0, unchanged: 0, removed: 0, skippedOpenShifts: 0, assignmentsKept: 0,
        assignmentsToRemove: [{ board: "caja", stationId: "yellow", hour: 12 }], assignmentsToTransfer: [{ board: "caja", stationId: "yellow", hour: 13 }] }] };
    const imported = renderToStaticMarkup(createElement(ImportPreviewModal, { preview, busy: false, onCancel() {}, onConfirm() {}, locale, t: messagesFor(locale) }));
    expect(imported.match(/Synthetic custom corner/g)).toHaveLength(2);
    const returned = renderToStaticMarkup(createElement(ReturnPromptBanner, { stations,
      prompts: [{ id: "example", message: "return", loadStationId: "yellow", seatId: "yellow", employee: { id: "example", firstName: "Example", lastName: "Worker" } }],
      mute: false, onMuteChange() {}, onAck() {}, readonly: true, locale, t: messagesFor(locale) }));
    expect(returned).toContain("Synthetic custom corner");
    expect(returned).not.toContain(locale === "es" ? "regresa a Amarillo 1" : "return to Yellow 1");
  });
});
