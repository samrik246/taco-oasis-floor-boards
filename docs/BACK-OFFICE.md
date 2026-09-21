# Back office

Desk UI for Sam. English. Not the floor tablet.

Open [http://HOME_BASE:3000/back-office](http://HOME_BASE:3000/back-office). Enter a manager code (same hashed codes as the floor). Demo codes are in [DEPLOY.md](./DEPLOY.md): Ana `2468`, Luis `1357`, Sam `8642`. The page never shows those codes or the stored hashes.

From there you can edit what the floor uses:

- Station labels, colors, short codes, and which board they sit on
- People and station abilities
- Tarea template labels
- The day’s seat plan
- Historical sales-by-hour percents (share of that day’s sales) used by Rush / Más ocupado

Changes are stored in SQLite and show up on caja and cocina. The kitchen board keeps Spanish labels until a station or tarea label is edited away from the seed.

The floor’s 15-second idle logout does not apply here. This tab keeps a manager session until you click Log out or the token expires (12 hours). Floor tablets still drop the manager view after 15 seconds idle.

Wall / glance mode is separate: `/?wall=1` (English caja) and `/?wall=1&board=cocina` (Spanish cocina).
