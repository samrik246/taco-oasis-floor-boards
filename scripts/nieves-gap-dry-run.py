#!/usr/bin/env python3
"""Classify a retained read-only receipt. No database connection or repair writes."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo


def classify(receipt, receipt_sha):
    if receipt.get("query_only") != 1:
        raise ValueError("A query-only receipt is required")
    rows = receipt.get("shifts")
    if not isinstance(rows, list):
        raise ValueError("Missing shift snapshot")
    excluded = []
    for row in rows:
        if row["sourcePosition"] != "Caja - Nieves" or row["boardRemoved"]:
            continue
        start, end = row["startAt"], row["endAt"]
        if not isinstance(start, int) or not isinstance(end, int) or start >= end:
            raise ValueError("Invalid factual source interval")
        day = datetime.date.fromisoformat(row["date"])
        bounds = [int(datetime.datetime.combine(day, datetime.time(hour), ZoneInfo("America/Chicago")).timestamp() * 1000) for hour in (7, 22)]
        clipped = [max(start, bounds[0]), min(end, bounds[1])]
        if clipped[0] >= clipped[1]:
            continue
        instant = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        excluded.append({
            "shiftId": row["id"], "worker": f'{row["firstName"]} {row["lastName"]}'.strip(), "date": row["date"],
            "sourceStartAt": instant(start), "sourceEndAt": instant(end),
            "reviewStartAt": instant(clipped[0]), "reviewEndAt": instant(clipped[1]),
            "assignedHourCount": row["assignedHours"], "assignedStations": row["assignedStations"],
            "before": "empty hourly assignments" if row["assignedHours"] == 0 else "aggregate assignment count only",
            "after": "unchanged",
            "reason": "AMBIGUOUS_BLANK_INTENT" if row["assignedHours"] == 0 else "EXACT_HOURLY_ROWS_NOT_IN_RECEIPT",
        })
    return {
        "mode": "dry-run", "databaseWrites": 0, "executableRepair": False,
        "inputReceiptSha256": receipt_sha, "observedAt": receipt.get("observedAt"),
        "databasePathFromReceipt": receipt.get("database"), "databaseSnapshotSha256": None,
        "snapshotLimit": "Selected aggregate receipt; not a complete database snapshot or erasure history.",
        "proposedDelta": [], "excluded": excluded,
        "duplicatePolicy": "Identical export remains DUPLICATE or receipt replay; neither authorizes backfill.",
        "repairGate": "Obtain exact current rows and affirmative omission evidence or an explicit placement decision; review exact delta, command, runtime, runner, independent checker and rollback before any live execution.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    raw = args.receipt.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != args.expected_sha256:
        raise ValueError("Receipt hash mismatch")
    report = classify(json.loads(raw), digest)
    with args.out.open("x") as stream:
        json.dump(report, stream, indent=2); stream.write("\n")
    print(json.dumps({"report": str(args.out), "sha256": hashlib.sha256(args.out.read_bytes()).hexdigest(), "proposed": 0, "excluded": len(report["excluded"]), "databaseWrites": 0}))


if __name__ == "__main__":
    main()
