/**
 * Board-scoped UI copy. Caja → English, Cocina → Spanish.
 * Seed/data keys stay stable; only display strings localize.
 */

export type Locale = "en" | "es";

export type Messages = {
  brand: string;
  cashiers: string;
  kitchen: string;
  staffView: string;
  managerView: string;
  unlockManager: string;
  exitManager: string;
  managerCode: string;
  managerCodeHint: string;
  unlock: string;
  cancel: string;
  wrongCode: string;
  managerUnlocked: (name: string) => string;
  managerIdleLogout: string;
  viewBoard: string;
  viewTimeline: string;
  viewSchedule: string;
  viewTareas: string;
  viewRush: string;
  scheduleTitle: string;
  scheduleHint: string;
  scheduleEmpty: string;
  scheduleAllDay: string;
  scheduleRestOfDay: string;
  scheduleModeLabel: string;
  scheduleSortLabel: string;
  scheduleSortName: string;
  scheduleSortTime: string;
  scheduleSortPosition: string;
  scheduleRestRuleToday: string;
  scheduleRestRuleOther: string;
  scheduleHeadcount: string;
  scheduleManHours: string;
  scheduleShiftCol: string;
  scheduleAreaCol: string;
  scheduleUnassignedGroup: string;
  rushTitle: string;
  rushHint: string;
  rushBasis: string;
  rushPrep: string;
  rushMethod: string;
  rushSummaryLead: string;
  rushEmptyDate: string;
  rushOrders: string;
  rushMark: string;
  date: string;
  hour: string;
  noDates: string;
  loadSample: string;
  upload: string;
  autofillSoon: string;
  readonly: string;
  largeTablet: string;
  compactTablet: string;
  available: string;
  abilityFilter: string;
  abilityAll: string;
  tapHint: string;
  readonlyHint: string;
  noOneAvailable: string;
  loadOrUpload: string;
  stationsHeading: (board: string, date: string) => string;
  cancelSwap: string;
  loading: string;
  emptyShifts: (date: string) => string;
  emptyState: string;
  noStationsSeeded: string;
  maxLabel: (n: number) => string;
  full: string;
  empty: string;
  tapToAssign: string;
  toastAssigned: string;
  toastCleared: string;
  toastSwapped: string;
  toastSwapPick: string;
  toastSample: (n: number) => string;
  toastImported: (n: number) => string;
  toastReadonly: string;
  toastForbidden: string;
  toastSimulatorOn: string;
  toastSimulatorOff: string;
  toastTareaAssigned: string;
  toastLoadFailed: string;
  toastNetwork: string;
  toastAssignRejected: string;
  toastClearFailed: string;
  toastSwapRejected: string;
  toastMoveFailed: string;
  toastTareaFailed: string;
  toastTareaUpdateFailed: string;
  toastAckFailed: string;
  toastSimToggleFailed: string;
  toastUploadFailed: string;
  toastSampleFailed: string;
  managerOnly: string;
  offlineBadge: string;
  offlineBanner: string;
  wallTitle: string;
  wallHint: string;
  wallEmptySeat: string;
  wallOffHours: string;
  orderTraffic: string;
  simulator: string;
  trafficHint: string;
  loadingMeters: string;
  quiet: string;
  busy: string;
  slammed: string;
  seats: string;
  tareasTitle: string;
  tareasHint: string;
  pickTarea: string;
  suggestions: string;
  top: string;
  next: string;
  assignTarea: string;
  forceLemon: string;
  working: string;
  done: string;
  markDone: string;
  markWorking: string;
  noWorking: string;
  noDone: string;
  backlogWhenSlow: string;
  returnToStation: string;
  muteChime: string;
  acknowledge: string;
  moveOffStation: string;
  moveLeaving: (name: string, seat: string) => string;
  reason: string;
  noteOptional: string;
  notePlaceholder: string;
  confirmClear: string;
  hoursThisWeek: string;
  pickPersonHours: string;
  loadingHours: string;
  noHours: string;
  stationCol: string;
  minutesCol: string;
  managerNotes: string;
  addNote: string;
  notePlaceholderDay: string;
  save: string;
  edit: string;
  delete: string;
  noNotes: string;
  performanceTitle: string;
  closeDaySurvey: string;
  pickPersonSurvey: string;
  openSurvey: string;
  saveAnswers: string;
  employeesTitle: string;
  manageEmployees: string;
  timelineTitle: string;
  timelineHint: string;
  timelineEmpty: string;
  timelineOffShift: string;
  timelineUnassigned: string;
  /** C1: a shift a newer schedule replaced; its past hours stay as history. */
  shiftEnded: string;
  importPreviewTitle: string;
  importPreviewIntro: string;
  importCounts: (c: { added: number; changed: number; unchanged: number; removed: number }) => string;
  importKept: (n: number) => string;
  importOpenShifts: (n: number) => string;
  importRemoveTitle: string;
  importRemoveNone: string;
  importRefusedTitle: string;
  importConfirm: string;
  toastScheduleUpdated: string;
  person: string;
  position: string;
  violations: (n: number) => string;
  moveBreak: string;
  moveCoverExpo: string;
  moveTraining: string;
  moveHelpSlammed: string;
  moveOther: string;
  abilityPreferred: string;
  abilityOk: string;
  abilityTraining: string;
  abilityForbidden: string;
  localeToggleLabel: string;
  datePrev: string;
  dateNext: string;
  today: string;
  todayNotImported: string;
  saving: string;
};

const en: Messages = {
  brand: "Taco Oasis",
  cashiers: "Cashiers",
  kitchen: "Kitchen",
  staffView: "Staff",
  managerView: "Manager",
  unlockManager: "Manager unlock",
  exitManager: "Exit manager",
  managerCode: "Manager code",
  managerCodeHint: "Enter your personal manager code",
  unlock: "Unlock",
  cancel: "Cancel",
  wrongCode: "Wrong code",
  managerUnlocked: (name) => `Manager: ${name}`,
  managerIdleLogout: "Manager session timed out — back to staff",
  viewBoard: "Board",
  viewTimeline: "Timeline",
  viewSchedule: "Schedule",
  viewTareas: "Tareas",
  viewRush: "Rush",
  scheduleTitle: "Day schedule",
  scheduleHint:
    "Same people and hours. By name, each block is the position. By time, rows follow start time. By position, each block is the person.",
  scheduleEmpty: "No people on this board for this date.",
  scheduleAllDay: "All day",
  scheduleRestOfDay: "Rest of day",
  scheduleModeLabel: "Schedule range",
  scheduleSortLabel: "Sort",
  scheduleSortName: "By name",
  scheduleSortTime: "By time",
  scheduleSortPosition: "By position",
  scheduleRestRuleToday: "Rest of day from now (Chicago).",
  scheduleRestRuleOther:
    "Not today — columns from the first scheduled hour on this date.",
  scheduleHeadcount: "Headcount",
  scheduleManHours: "Man-hours",
  scheduleShiftCol: "Shift",
  scheduleAreaCol: "Area",
  scheduleUnassignedGroup: "Unassigned",
  rushTitle: "When it gets busier",
  rushHint: "Historical sales by weekday and hour — prep before the rush.",
  rushBasis:
    "Share of that day’s sales by hour, from historical sales (sample history). Not order counts. Not a live POS.",
  rushPrep: "Prep before the rush — have people and the line ready before these hours.",
  rushMethod:
    "Rush = an hour’s share of that day’s sales above 1.35× this weekday’s median hour.",
  rushSummaryLead: "Gets busier around",
  rushEmptyDate: "Pick a date to see the usual rush.",
  rushOrders: "% of day",
  rushMark: "Rush",
  date: "Date",
  hour: "Hour",
  noDates: "No dates",
  loadSample: "Load sample",
  upload: "Upload",
  autofillSoon: "Auto-fill (coming soon)",
  readonly: "Read-only",
  largeTablet: "Large tablet UI",
  compactTablet: "Compact tablet UI",
  available: "Available",
  abilityFilter: "Ability filter",
  abilityAll: "All (hide forbidden)",
  tapHint: "Tap a station, then a person — or tap a person then a station.",
  readonlyHint: "Viewing only — assign/swap/clear/notes are disabled.",
  noOneAvailable: "No one available for this hour.",
  loadOrUpload: "Load sample or upload a schedule.",
  stationsHeading: (board, date) =>
    date ? `${board} stations · ${date}` : `${board} stations`,
  cancelSwap: "Cancel swap",
  loading: "Loading…",
  emptyShifts: (date) =>
    `No shifts on this board for ${date}. Try another date or Load sample.`,
  emptyState: "Load the sample schedule or upload a When I Work export to begin.",
  noStationsSeeded: "No stations seeded for this board. Run pnpm db:setup.",
  maxLabel: (n) => `max ${n}`,
  full: "full",
  empty: "Empty",
  tapToAssign: "Tap to assign",
  toastAssigned: "Assigned",
  toastCleared: "Cleared (reason logged)",
  toastSwapped: "Swapped",
  toastSwapPick: "Tap second assignment to swap",
  toastSample: (n) => `Loaded sample (${n} rows)`,
  toastImported: (n) => `Imported ${n} rows`,
  toastReadonly: "Read-only mode — mutations blocked",
  toastForbidden: "This person can't work that station.",
  toastSimulatorOn: "Training on",
  toastSimulatorOff: "Training off",
  toastTareaAssigned: "Tarea assigned",
  toastLoadFailed: "Failed to load board",
  toastNetwork: "Network error loading board",
  toastAssignRejected: "Assign rejected",
  toastClearFailed: "Clear failed",
  toastSwapRejected: "Swap rejected",
  toastMoveFailed: "Move log failed",
  toastTareaFailed: "Tarea assign failed",
  toastTareaUpdateFailed: "Could not update tarea",
  toastAckFailed: "Could not acknowledge",
  toastSimToggleFailed: "Could not toggle simulator",
  toastUploadFailed: "Upload failed",
  toastSampleFailed: "Sample load failed",
  managerOnly: "Manager only",
  offlineBadge: "Offline",
  offlineBanner:
    "Offline — last saved board, read only. Edits wait until this tablet reconnects. Nothing here is written from the cache.",
  wallTitle: "Wall",
  wallHint: "Current hour. No edits.",
  wallEmptySeat: "Open",
  wallOffHours: "Outside service hours",
  orderTraffic: "Training traffic",
  simulator: "Training",
  trafficHint:
    "Training switch only, default off. A manager turns it on. Fake Quiet / Busy / Slammed — not a POS. Tareas clear only while training is on.",
  loadingMeters: "Loading meters…",
  quiet: "Quiet",
  busy: "Busy",
  slammed: "Slammed",
  seats: "seats",
  tareasTitle: "Cashiers tareas",
  tareasHint:
    "Homework-style daily list. Multi active OK. Chiles = when-slow backlog.",
  pickTarea: "Pick tarea",
  suggestions: "Suggestions",
  top: "top",
  next: "next",
  assignTarea: "Assign",
  forceLemon: "Force lemon warn",
  working: "Working",
  done: "Done",
  markDone: "Done",
  markWorking: "Working",
  noWorking: "None working",
  noDone: "None done",
  backlogWhenSlow: "When slow",
  returnToStation: "Return to station",
  muteChime: "Mute chime",
  acknowledge: "Got it",
  moveOffStation: "Move off station",
  moveLeaving: (name, seat) => `${name} leaving ${seat} — pick a reason.`,
  reason: "Reason",
  noteOptional: "Note (optional)",
  notePlaceholder: "Optional detail",
  confirmClear: "Confirm clear",
  hoursThisWeek: "Hours this week",
  pickPersonHours: "Select a person to see hours.",
  loadingHours: "Loading hours…",
  noHours: "No hours logged yet.",
  stationCol: "Station",
  minutesCol: "Minutes",
  managerNotes: "Manager notes",
  addNote: "Add note",
  notePlaceholderDay: "Day note…",
  save: "Save",
  edit: "Edit",
  delete: "Delete",
  noNotes: "No notes yet.",
  performanceTitle: "Close-day performance",
  closeDaySurvey: "Close-day survey",
  pickPersonSurvey: "Select a person first.",
  openSurvey: "Open survey",
  saveAnswers: "Save answers",
  employeesTitle: "Employees / abilities",
  manageEmployees: "Manage",
  timelineTitle: "People × time × position",
  timelineHint:
    "Rows are people on this board today. Columns are hours. Cells show assigned station.",
  timelineEmpty: "No people on this board for this date.",
  timelineOffShift: "—",
  timelineUnassigned: "Open",
  shiftEnded: "Ended",
  importPreviewTitle: "Update the schedule?",
  importPreviewIntro: "This file changes a day that is already on the board. Nothing changes until you confirm.",
  importCounts: (c) =>
    `${c.added} added · ${c.changed} changed · ${c.unchanged} unchanged · ${c.removed} removed`,
  importKept: (n) => `${n} assignments kept`,
  importOpenShifts: (n) => `${n} open shifts skipped (no employee)`,
  importRemoveTitle: "These assignments no longer fit the new schedule and will be removed:",
  importRemoveNone: "No assignments will be removed.",
  importRefusedTitle: "Not imported. Nothing changed:",
  importConfirm: "Confirm update",
  toastScheduleUpdated: "Schedule updated",
  person: "Person",
  position: "Position",
  violations: (n) =>
    `${n} violation${n === 1 ? "" : "s"} on this board`,
  moveBreak: "Break",
  moveCoverExpo: "Cover expo",
  moveTraining: "Training",
  moveHelpSlammed: "Help slammed",
  moveOther: "Other",
  abilityPreferred: "Preferred",
  abilityOk: "OK",
  abilityTraining: "Training",
  abilityForbidden: "Forbidden",
  localeToggleLabel: "Language",
  datePrev: "Previous day",
  dateNext: "Next day",
  today: "Today",
  todayNotImported: "Today isn't imported yet",
  saving: "Saving…",
};

const es: Messages = {
  brand: "Taco Oasis",
  cashiers: "Caja",
  kitchen: "Cocina",
  staffView: "Personal",
  managerView: "Gerente",
  unlockManager: "Desbloquear gerente",
  exitManager: "Salir de gerente",
  managerCode: "Código de gerente",
  managerCodeHint: "Ingresa tu código personal de gerente",
  unlock: "Desbloquear",
  cancel: "Cancelar",
  wrongCode: "Código incorrecto",
  managerUnlocked: (name) => `Gerente: ${name}`,
  managerIdleLogout: "Sesión de gerente expiró — vuelves a personal",
  viewBoard: "Tablero",
  viewTimeline: "Línea de tiempo",
  viewSchedule: "Horario",
  viewTareas: "Tareas",
  viewRush: "Más ocupado",
  scheduleTitle: "Horario del día",
  scheduleHint:
    "Las mismas personas y horas. Por nombre, el bloque muestra el puesto. Por hora, las filas siguen la hora de entrada. Por puesto, el bloque muestra a la persona.",
  scheduleEmpty: "Nadie en este tablero para esta fecha.",
  scheduleAllDay: "Todo el día",
  scheduleRestOfDay: "Resto del día",
  scheduleModeLabel: "Rango del horario",
  scheduleSortLabel: "Orden",
  scheduleSortName: "Por nombre",
  scheduleSortTime: "Por hora",
  scheduleSortPosition: "Por puesto",
  scheduleRestRuleToday: "Resto del día desde ahora (Chicago).",
  scheduleRestRuleOther:
    "Otra fecha — columnas desde la primera hora programada de este día.",
  scheduleHeadcount: "Personas",
  scheduleManHours: "Horas-hombre",
  scheduleShiftCol: "Turno",
  scheduleAreaCol: "Área",
  scheduleUnassignedGroup: "Sin asignar",
  rushTitle: "Cuándo se pone más ocupado",
  rushHint:
    "Ventas históricas por día de la semana y hora — prepárate antes del rush.",
  rushBasis:
    "Parte de las ventas del día por hora, según ventas históricas (muestra). No son pedidos. No es un POS en vivo.",
  rushPrep:
    "Prepárate antes del rush — deja a la gente y la línea listas antes de estas horas.",
  rushMethod:
    "Pico = la parte de las ventas del día por encima de 1.35× la mediana de ese día.",
  rushSummaryLead: "Se pone más ocupado alrededor de",
  rushEmptyDate: "Elige una fecha para ver el pico habitual.",
  rushOrders: "% del día",
  rushMark: "Pico",
  date: "Fecha",
  hour: "Hora",
  noDates: "Sin fechas",
  loadSample: "Cargar muestra",
  upload: "Subir",
  autofillSoon: "Auto-llenar (próximamente)",
  readonly: "Solo lectura",
  largeTablet: "UI tablet grande",
  compactTablet: "UI tablet compacta",
  available: "Disponibles",
  abilityFilter: "Filtro de habilidad",
  abilityAll: "Todos (ocultar prohibidos)",
  tapHint: "Toca una estación, luego una persona — o al revés.",
  readonlyHint: "Solo vista — asignar/intercambiar/limpiar/notas deshabilitado.",
  noOneAvailable: "Nadie disponible en esta hora.",
  loadOrUpload: "Carga la muestra o sube un horario.",
  stationsHeading: (board, date) =>
    date ? `Estaciones ${board} · ${date}` : `Estaciones ${board}`,
  cancelSwap: "Cancelar intercambio",
  loading: "Cargando…",
  emptyShifts: (date) =>
    `Sin turnos en este tablero para ${date}. Prueba otra fecha o Cargar muestra.`,
  emptyState:
    "Carga el horario de muestra o sube un export de When I Work para empezar.",
  noStationsSeeded:
    "No hay estaciones sembradas. Ejecuta pnpm db:setup.",
  maxLabel: (n) => `máx ${n}`,
  full: "lleno",
  empty: "Vacío",
  tapToAssign: "Toca para asignar",
  toastAssigned: "Asignado",
  toastCleared: "Liberado (motivo registrado)",
  toastSwapped: "Intercambiado",
  toastSwapPick: "Toca la segunda asignación para intercambiar",
  toastSample: (n) => `Muestra cargada (${n} filas)`,
  toastImported: (n) => `Importadas ${n} filas`,
  toastReadonly: "Modo solo lectura — mutaciones bloqueadas",
  toastForbidden: "Esta persona no puede trabajar esa estación.",
  toastSimulatorOn: "Entrenamiento encendido",
  toastSimulatorOff: "Entrenamiento apagado",
  toastTareaAssigned: "Tarea asignada",
  toastLoadFailed: "No se pudo cargar el tablero",
  toastNetwork: "Error de red al cargar el tablero",
  toastAssignRejected: "Asignación rechazada",
  toastClearFailed: "No se pudo liberar",
  toastSwapRejected: "Intercambio rechazado",
  toastMoveFailed: "No se pudo registrar el movimiento",
  toastTareaFailed: "No se pudo asignar la tarea",
  toastTareaUpdateFailed: "No se pudo actualizar la tarea",
  toastAckFailed: "No se pudo confirmar",
  toastSimToggleFailed: "No se pudo cambiar el simulador",
  toastUploadFailed: "Fallo al subir",
  toastSampleFailed: "Fallo al cargar muestra",
  managerOnly: "Solo gerente",
  offlineBadge: "Sin conexión",
  offlineBanner:
    "Sin conexión — último tablero guardado, solo lectura. Los cambios esperan a que vuelva la base. El caché no escribe nada.",
  wallTitle: "Pared",
  wallHint: "Hora actual. Sin cambios.",
  wallEmptySeat: "Libre",
  wallOffHours: "Fuera del horario",
  orderTraffic: "Tráfico de entrenamiento",
  simulator: "Entrenamiento",
  trafficHint:
    "Solo entrenamiento, apagado por defecto. Lo prende un gerente. Tranquilo / Ocupado / Saturado falso — no es POS. Las tareas se liberan solo con el entrenamiento encendido.",
  loadingMeters: "Cargando medidores…",
  quiet: "Tranquilo",
  busy: "Ocupado",
  slammed: "Saturado",
  seats: "puestos",
  tareasTitle: "Tareas de cocina",
  tareasHint:
    "Lista diaria tipo tarea. Varias activas OK. Algunas = solo cuando hay calma.",
  pickTarea: "Elegir tarea",
  suggestions: "Sugerencias",
  top: "mejor",
  next: "siguiente",
  assignTarea: "Asignar",
  forceLemon: "Forzar aviso limón",
  working: "En curso",
  done: "Hecha",
  markDone: "Hecha",
  markWorking: "En curso",
  noWorking: "Ninguna en curso",
  noDone: "Ninguna hecha",
  backlogWhenSlow: "Cuando hay calma",
  returnToStation: "Regresar a estación",
  muteChime: "Silenciar tono",
  acknowledge: "Entendido",
  moveOffStation: "Quitar de estación",
  moveLeaving: (name, seat) =>
    `${name} sale de ${seat} — elige un motivo.`,
  reason: "Motivo",
  noteOptional: "Nota (opcional)",
  notePlaceholder: "Detalle opcional",
  confirmClear: "Confirmar",
  hoursThisWeek: "Horas de esta semana",
  pickPersonHours: "Selecciona una persona para ver horas.",
  loadingHours: "Cargando horas…",
  noHours: "Aún no hay horas registradas.",
  stationCol: "Estación",
  minutesCol: "Minutos",
  managerNotes: "Notas del gerente",
  addNote: "Agregar nota",
  notePlaceholderDay: "Nota del día…",
  save: "Guardar",
  edit: "Editar",
  delete: "Eliminar",
  noNotes: "Sin notas aún.",
  performanceTitle: "Desempeño de cierre",
  closeDaySurvey: "Encuesta de cierre",
  pickPersonSurvey: "Selecciona una persona primero.",
  openSurvey: "Abrir encuesta",
  saveAnswers: "Guardar respuestas",
  employeesTitle: "Empleados / habilidades",
  manageEmployees: "Administrar",
  timelineTitle: "Personas × tiempo × puesto",
  timelineHint:
    "Filas: personas del tablero hoy. Columnas: horas. Celdas: estación asignada.",
  timelineEmpty: "Nadie en este tablero para esta fecha.",
  timelineOffShift: "—",
  timelineUnassigned: "Libre",
  shiftEnded: "Terminó",
  importPreviewTitle: "¿Actualizar el horario?",
  importPreviewIntro: "Este archivo cambia un día que ya está en el tablero. Nada cambia hasta que confirmes.",
  importCounts: (c) =>
    `${c.added} nuevos · ${c.changed} cambiados · ${c.unchanged} sin cambio · ${c.removed} quitados`,
  importKept: (n) => `${n} asignaciones se quedan`,
  importOpenShifts: (n) => `${n} turnos abiertos omitidos (sin empleado)`,
  importRemoveTitle: "Estas asignaciones ya no caben en el nuevo horario y se quitarán:",
  importRemoveNone: "No se quitará ninguna asignación.",
  importRefusedTitle: "No se importó. Nada cambió:",
  importConfirm: "Confirmar",
  toastScheduleUpdated: "Horario actualizado",
  person: "Persona",
  position: "Puesto",
  violations: (n) =>
    `${n} violación${n === 1 ? "" : "es"} en este tablero`,
  moveBreak: "Descanso",
  moveCoverExpo: "Cubrir expo",
  moveTraining: "Entrenamiento",
  moveHelpSlammed: "Ayudar saturado",
  moveOther: "Otro",
  abilityPreferred: "Preferida",
  abilityOk: "Bien",
  abilityTraining: "Entrenamiento",
  abilityForbidden: "Prohibida",
  localeToggleLabel: "Idioma",
  datePrev: "Día anterior",
  dateNext: "Día siguiente",
  today: "Hoy",
  todayNotImported: "Hoy aún no está importado",
  saving: "Guardando…",
};

export const MESSAGES: Record<Locale, Messages> = { en, es };

/** Station id → display label per locale (keys stay stable in DB). */
export const STATION_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    mana: "MANA (Manager)",
    green1: "Green 1",
    yellow: "Yellow / Outside",
    purple1: "Purple 1",
    green2: "Green 2 / Jolt",
    blue: "Blue / Outside",
    purple2: "Purple 2",
    multi: "MULTI",
    nieves: "Nieves",
    mesero: "Mesero",
    clean: "Limpieza / Clean",
    fryer: "Fryer",
    tortilla: "Tortilla",
    birria: "Birria",
    taquero: "Taquero",
    carne: "Carne",
    prepa: "Prepa",
  },
  es: {
    mana: "MANA (Gerente)",
    green1: "Verde 1",
    yellow: "Amarillo / Afuera",
    purple1: "Morado 1",
    green2: "Verde 2 / Jolt",
    blue: "Azul / Afuera",
    purple2: "Morado 2",
    multi: "MULTI",
    nieves: "Nieves",
    mesero: "Mesero",
    clean: "Limpieza",
    fryer: "Freidora",
    tortilla: "Tortilla",
    birria: "Birria",
    taquero: "Taquero",
    carne: "Carne",
    prepa: "Prepa",
  },
};

/** Tarea template id → display label. */
export const TAREA_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    positions: "POSITIONS (color board clear)",
    desvenar_chiles: "DESVENAR CHILES",
    salsa: "SALSA",
    crema_dulce: "CREMA DULCE",
    chunky_salsa: "CHUNKY SALSA",
    fire_salsa: "FIRE SALSA",
    red_baby_salsa: "RED BABY SALSA",
    green_baby_salsa: "GREEN BABY SALSA",
    ranch: "RANCH",
    chipotle_ranch: "CHIPOTLE RANCH",
    caesar_dressing: "CAESAR DRESSING",
    italian_dressing: "ITALIAN DRESSING",
    lemon: "LEMON CUT/SQUEEZE",
    aguas_frescas: "AGUAS FRESCAS",
    aguas_sublist: "Aguas! (sublist)",
    prep_salsa_bar: "Prep salsa bar restock",
    wipe_line: "Wipe / sanitize line",
    restock_tortillas: "Restock tortillas",
    restock_gloves: "Restock gloves / foil",
    deep_clean_fryer: "Deep clean fryer area",
    prep_birria: "Prep birria garnish/consomé",
    stock_carne: "Stock carne station",
    trash_runs: "Trash / cardboard runs",
    dish_assist: "Dish assist",
  },
  es: {
    positions: "POSICIONES (tablero claro)",
    desvenar_chiles: "DESVENAR CHILES",
    salsa: "SALSA",
    crema_dulce: "CREMA DULCE",
    chunky_salsa: "SALSA CHUNKY",
    fire_salsa: "SALSA FIRE",
    red_baby_salsa: "SALSA BABY ROJA",
    green_baby_salsa: "SALSA BABY VERDE",
    ranch: "RANCH",
    chipotle_ranch: "RANCH CHIPOTLE",
    caesar_dressing: "ADEREZO CÉSAR",
    italian_dressing: "ADEREZO ITALIANO",
    lemon: "LIMÓN CORTAR/EXPRIMIR",
    aguas_frescas: "AGUAS FRESCAS",
    aguas_sublist: "¡Aguas! (sublista)",
    prep_salsa_bar: "Preparar reposición de salsa",
    wipe_line: "Limpiar / sanitizar línea",
    restock_tortillas: "Reponer tortillas",
    restock_gloves: "Reponer guantes / foil",
    deep_clean_fryer: "Limpieza profunda freidora",
    prep_birria: "Preparar guarnición/consomé birria",
    stock_carne: "Abastecer estación de carne",
    trash_runs: "Basura / cartón",
    dish_assist: "Ayuda en trastes",
  },
};

export const LOAD_STATION_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    nieves: "Nieves",
    cliente: "Cliente",
    carro: "Carro",
    expo: "Expo",
    fryer: "Fryer",
    tortilla: "Tortilla",
    birria: "Birria",
    taquero: "Taquero",
    carne: "Carne",
    prepa: "Prepa",
  },
  es: {
    nieves: "Nieves",
    cliente: "Cliente",
    carro: "Carro",
    expo: "Expo",
    fryer: "Freidora",
    tortilla: "Tortilla",
    birria: "Birria",
    taquero: "Taquero",
    carne: "Carne",
    prepa: "Prepa",
  },
};

/** Performance question id → prompt. */
export const PERFORMANCE_PROMPTS: Record<Locale, Record<string, string>> = {
  en: {
    pq_stayed_on_station:
      "Did this person stay on station when traffic was Busy/Slammed?",
    pq_tareas_finished:
      "Did they finish assigned tareas or leave them hanging?",
    pq_seat_tomorrow: "Would you seat them on the same position tomorrow?",
    pq_free_note: "Free note (optional)",
  },
  es: {
    pq_stayed_on_station:
      "¿Se quedó en estación cuando el tráfico estaba Ocupado/Saturado?",
    pq_tareas_finished:
      "¿Terminó las tareas asignadas o las dejó pendientes?",
    pq_seat_tomorrow: "¿Lo sentarías en el mismo puesto mañana?",
    pq_free_note: "Nota libre (opcional)",
  },
};
