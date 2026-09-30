/* eslint-disable @typescript-eslint/no-require-imports -- a node script run by hand, outside the app */
// Print-model fixture for the SQUARE NEXT fixture order AgIeZY.
// Built by the real C1 sheet model code (ECO-t4g-creator origin/main 8587677:
// 30_pull_list.gs, 50_c1_sync.gs, 80_c1_order_sheet.gs placed next to this file).
// LO QUE PIDIERON matches fixtures/square-next/orders.json; the CALIENTE / FRÍO /
// EQUIPO quantities are synthetic test values, not a recipe computation.
const fs = require('node:fs'); const vm = require('node:vm');
const sandbox = { PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'X' }) } };
vm.createContext(sandbox);
for (const n of ['30_pull_list.gs','50_c1_sync.gs','80_c1_order_sheet.gs']) vm.runInContext(fs.readFileSync(n,'utf8'), sandbox, {filename:n});
const orders = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).orders;
const o = orders.find(x => x.id_tail === 'AgIeZY');
const orderId = 'ORDFIXTUREAgIeZY';
const lines = ['TEST C1 · COCINA', 'JUEVES 15 OCT · PICKUP · 15 PERSONAS (confirm)',
  'LISTO PARA RECOGER: 10:00 AM          Orden AgIeZY', '', 'LO QUE PIDIERON',
  '  5  Taco Tray ASADA', '  5  Taco Tray PASTOR', '  5  Taco Tray POLLO',
  '  13  Rice Tray', '  13  Beans Tray', '  1  Aguas Frescas Gallon MELÓN', '  1  Aguas Frescas Gallon PIÑA',
  '  14  Dips for Chips',
  '', 'CALIENTE · charolas con foil',
  '  [ ] 1.25 lb ASADA', '  [ ] 1.25 lb PASTOR', '  [ ] 1.25 lb POLLO',
  '  [ ] 30 tortillas de MAIZ', '  [ ] 3.25 lb arroz', '  [ ] 3.25 lb frijoles',
  '', 'FRÍO · botes 32oz',
  '  [ ] 1 galón agua de melón', '  [ ] 1 galón agua de piña', '  [ ] 3.5 bote 32oz salsa chunky',
  '  [ ] 0.5 bote 32oz salsa verde y roja', '  [ ] 0.25 bote 32oz cilantro, cebolla y limón',
  '', 'EQUIPO',
  '  [ ] 16 platos', '  [ ] 16 tenedores', '  [ ] 16 servilletas', '  [ ] 2 pinzas grandes',
  '  [ ] 2 cucharas grandes', '  [ ] 1 bolsas de hielo', '  [ ] 32 vasos transparentes 16oz',
  '', 'REVIEW / INFO NEEDED', '(none)'];
const kitchenLines = o.lines.map((l, i) => ({ 'Square Order ID': orderId, 'Line Item UID': 'fixture-' + (i + 1),
  'Event Date': o.event_date, 'Event Time': o.event_time, 'Fulfill Type': o.fulfill_type,
  'Item Name': l.item_name, Variation: l.variation, 'Modifiers (raw)': l.modifiers, Qty: l.qty }));
const m = sandbox.c1OrderSheetModel_(lines, { orderId, firstName: 'Fixture', eventDate: o.event_date,
  eventTime: o.event_time, fulfillType: o.fulfill_type, kitchenLines });
process.stdout.write(JSON.stringify({ rows: m.rows, sectionRows: m.sectionRows, reviewRow: m.reviewRow,
  orderId: m.orderId, idTail: m.idTail, eventDate: m.eventDate, eventTime: m.eventTime,
  fulfillType: m.fulfillType, guests: m.guests }, null, 2) + '\n');
