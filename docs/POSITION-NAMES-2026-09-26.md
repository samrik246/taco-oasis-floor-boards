# Position names and retired Cocina seats

Richard's answered position-name card is recorded exactly in
`operations/position-names-2026-09-26.json`. It retains 32 station IDs, changes
13 labels, and requests removal of six older unnumbered Cocina seats. The
operation changes saved Station labels, transfers ability levels to the
corresponding numbered seats, and then deletes the six old Station rows and
ability rows. It preserves all retained IDs, codes, colors, capacities, and
assignments. It refuses the entire operation if a removal candidate has a
saved assignment, move history, return prompt seat, or position mapping.

Before any live run, inspect the preview against the installed database:

```bash
python3 scripts/apply-position-names.py --db /path/to/floor-boards.db
```

After independent review and release authorization, the operator provides a
new backup path and runs the guarded transaction:

```bash
python3 scripts/apply-position-names.py --db /path/to/floor-boards.db --apply --backup /path/to/new-backup.db
```

The script repeats its guards under a write lock, writes a private SQLite
backup first, verifies the final station state, and prints the backup SHA-256.
Run the preview again for independent readback. The six `LoadStationMeter` IDs
are retained as load categories; their seat mapping now points to the numbered
Cocina stations. The ability transfer preserves each corresponding old level,
including `preferred` for Carne. Staff forbidden on all six old seats remain
forbidden on all retained Cocina seats. A conflicting saved ability on a
numbered seat or an incomplete old ability set stops the transaction. New
imports seed abilities against the retained numbered seats.

The schedule grid displays each saved full label in name/time sort. Its code
remains in `data-code`, and the cell can be opened by tap or keyboard to inspect
the label again.
