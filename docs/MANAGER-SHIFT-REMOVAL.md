# Manager shift removal and restoration

This control removes one imported shift occurrence from the floor board without changing When I Work. It is available only after a manager unlocks the timeline. The manager selects the person, date, position and time, enters a reason, and confirms. The shift disappears from staff board responses; its future station assignments are cleared. Started assignments stay in the database as history.

The manager-only removed-shift list shows source status and an append-only action history. Restore offers two deliberate choices. **With positions** replays only saved future station cells after validating the current source window, station capacity, employee ability and person/hour availability. Any conflict cancels the entire restore. **Without positions** makes the shift visible and leaves its cells empty for repainting. Neither choice changes When I Work.

## Data and import behavior

`Shift.boardRemoved` is an additive visibility flag, defaulting to false for every existing row. `ShiftRemoval` stores one override, its source occurrence snapshot and a revision. `ShiftRemovalEvent` records removal, restoration and import relinks. The import preview digest includes the override links and revisions; a manager action after Preview makes Confirm stale. A changed source window can carry a removal only with unique positive overlap. A missing shift leaves a tombstone. An exact, unique reappearance can relink it. Ambiguous split shifts produce `REMOVAL_IDENTITY` and the import writes nothing.

## Release and rollback

Before installing the feature, take a fresh online database backup after the latest legitimate import or board edit. Verify that the migration is additive on a disposable copy of that backup and that existing shifts default to visible. The release packet must pin the source artifact, schema operation, backup and exact preservation checks; an installation receipt and independent live readback are still required.

Rolling back the application can leave the new columns and tables in place. Do not restore an older database over later schedule or board edits. If the feature must be removed permanently, first export and review its override/event rows and prepare a separate data migration.

An earlier manually removed Gustavo shift is not automatically adopted into this new override table. That adoption requires its own exact-shift, reviewed data operation after the live source and board state are compared. Do not rerun the earlier correction or change the David-to-Carne assignment as part of the schema rollout.
