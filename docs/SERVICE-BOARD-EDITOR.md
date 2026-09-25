# Board service editor

`scripts/edit-board.py` applies a reviewed JSON packet to one installed Floor Boards database. The packet pins the installed `RELEASE_SHA` and exact current values. Every run names its packet SHA-256; a changed packet is refused. `--preflight-only` is read-only. `--apply` makes an SQLite online backup under `var/backups/board-edit-*`, takes a write lock, and refuses if any other database connection committed after the backup began. It then repeats the checks inside the transaction, changes all rows together, and checks each result before commit. A repeated packet refuses once its expected values are gone. A run that refuses because the database changed leaves a stale backup; do not restore that backup.

```sh
python3 scripts/edit-board.py --app-dir /absolute/installed/app --packet /absolute/reviewed/packet.json --expected-packet-sha256 <sha256> --preflight-only
python3 scripts/edit-board.py --app-dir /absolute/installed/app --packet /absolute/reviewed/packet.json --expected-packet-sha256 <sha256> --apply
```

Packet format: `{"version":1,"release":"<40-character release SHA>","operations":[...]}`. A packet has 1–100 operations of one type. Use `employeeExternalId` to identify the person; `assignmentId` or `shiftId` pins the exact row where relevant.

| Type | Required fields beyond `type` | Effect |
|---|---|---|
| `ability` | `employeeExternalId`, `stationId`, `from`, `to` | Set a station ability. `from` may be `null` for a new row; levels are `forbidden`, `training`, `ok`, `preferred`. |
| `shiftBoard` | `employeeExternalId`, `shiftId`, `date`, `from`, `to` | Change an active shift's board if its existing assignments fit the target board. |
| `clear` | `employeeExternalId`, `assignmentId`, `date`, `hour`, `fromStationId`, `reason` | Remove exactly that Chicago hour cell. |
| `move` | All `clear` fields plus `toStationId` | Move that assignment to an available station on the same board, subject to ability and occupancy checks. |

`reason` is one of `Break`, `Cover expo`, `Training`, `Help slammed`, `Other`. For a current or past hour, clear/move writes a `PositionMoveLog` row in the same transaction, matching the floor editor. A future hour needs no log row. All packets require a reason so they can safely be run after the hour begins.

The operator must inspect the preflight's `before`/`after` list and keep the apply output, especially `backup` and `backup_sha256`, for independent readback. This command does not assign new cells; the existing assignment API handles those after the old cells are cleared or moved.
