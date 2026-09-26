import { describe, expect, it } from "vitest";
import { hourGridHours } from "@/lib/hour-grid";
import {
  rejectManagerSecrets,
  seatRejection,
  validatePersonWrite,
  validateSalesPercents,
  validateStationWrite,
  validateTareaWrite,
} from "@/lib/admin/validate";

const others = [
  { id: "fryer", shortCode: "FRY" },
  { id: "yellow", shortCode: "YEL" },
];

describe("station writes", () => {
  it("accepts a complete station", () => {
    const result = validateStationWrite(
      {
        id: "expo",
        label: "Expo",
        color: "teal",
        shortCode: "EXP",
        board: "cocina",
        sortOrder: 8,
      },
      { id: "expo", creating: true, others },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.shortCode).toBe("EXP");
  });

  it("rejects a duplicate station id and a duplicate short code", () => {
    const dupId = validateStationWrite(
      {
        id: "fryer",
        label: "Fryer",
        color: "orange",
        shortCode: "ZZ",
        board: "cocina",
      },
      { id: "fryer", creating: true, others },
    );
    expect(dupId.ok).toBe(false);
    if (!dupId.ok) expect(dupId.error).toMatch(/already exists/);

    const dupCode = validateStationWrite(
      {
        label: "Other",
        color: "orange",
        shortCode: "fry",
        board: "cocina",
      },
      { id: "other", creating: false, others },
    );
    expect(dupCode.ok).toBe(false);
    if (!dupCode.ok) expect(dupCode.error).toMatch(/Short code FRY/);
  });

  it("rejects a missing label", () => {
    const result = validateStationWrite(
      { label: "  ", color: "orange", shortCode: "AB", board: "caja" },
      { id: "ab", creating: false, others },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Label is required/);
  });
});

describe("people writes", () => {
  const known = new Set(["fryer", "yellow"]);

  it("requires a name when creating", () => {
    const result = validatePersonWrite(
      { firstName: " ", lastName: "Cook" },
      { creating: true, knownStationIds: known },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/First name/);
  });

  it("rejects an unknown station and a bad ability", () => {
    const unknown = validatePersonWrite(
      {
        firstName: "Ana",
        lastName: "R",
        abilities: [{ stationId: "nope", level: "ok" }],
      },
      { creating: true, knownStationIds: known },
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/Unknown station/);

    const twice = validatePersonWrite(
      {
        abilities: [
          { stationId: "fryer", level: "ok" },
          { stationId: "fryer", level: "preferred" },
        ],
      },
      { creating: false, knownStationIds: known },
    );
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error).toMatch(/listed twice/);
  });
});

describe("tarea writes", () => {
  it("rejects an empty label and a bad mode", () => {
    expect(validateTareaWrite({ label: " " }).ok).toBe(false);
    const mode = validateTareaWrite({ label: "Dishes", mode: "sometimes" });
    expect(mode.ok).toBe(false);
    if (!mode.ok) expect(mode.error).toMatch(/mode/);
  });
});

describe("sales percents", () => {
  const hours = hourGridHours();

  it("accepts a day that adds up to about 100", () => {
    const percents = hours.map((hour, index) => ({
      hour,
      percent: index === 0 ? 100 : 0,
    }));
    const result = validateSalesPercents(percents);
    expect(result.ok).toBe(true);
  });

  it("rejects a day that is not a full share of sales", () => {
    const percents = hours.map((hour) => ({ hour, percent: 1 }));
    const result = validateSalesPercents(percents);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/about 100%/);
  });

  it("rejects a missing hour", () => {
    const percents = hours.slice(1).map((hour) => ({
      hour,
      percent: hour === 12 ? 100 : 0,
    }));
    const result = validateSalesPercents(percents);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Missing percent/);
  });
});

describe("manager secrets and seat conflicts", () => {
  it("refuses plaintext manager codes", () => {
    expect(rejectManagerSecrets({ name: "Ana" })).toBeNull();
    expect(rejectManagerSecrets({ code: "2468" })).toMatch(/never shown/);
    expect(rejectManagerSecrets({ codeHash: "abc" })).toMatch(/never shown/);
  });

  it("explains one person per station", () => {
    expect(
      seatRejection([
        { code: "STATION_FULL", message: "full" },
      ]),
    ).toMatch(/One person per station/);
    expect(
      seatRejection([
        { code: "PERSON_ALREADY_ASSIGNED", message: "busy" },
      ]),
    ).toMatch(/already on a station/);
  });
});

describe("station colors", () => {
  it("accepts maroon", () => {
    const result = validateStationWrite(
      {
        id: "expo",
        label: "Expo",
        color: "maroon",
        shortCode: "EXP",
        board: "cocina",
        sortOrder: 8,
      },
      { id: "expo", creating: true, others },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.color).toBe("maroon");
  });
});
