"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "@/lib/i18n";

export type BackOfficeCopy = {
  loading: string;
  title: string;
  intro: string;
  managerCode: string;
  wrongCode: string;
  enter: string;
  floorBoard: string;
  session: (name: string) => string;
  logOut: string;
  tabs: Record<string, string>;
  ownerRequired: string;
  savedStation: (id: string) => string;
  createdStation: (id: string) => string;
  stationsHelp: string;
  save: string;
  addStation: string;
  labelPh: string;
  codePh: string;
  personAdded: string;
  firstPh: string;
  lastPh: string;
  addPerson: string;
  savedTarea: (id: string) => string;
  seated: string;
  seatsHelp: string;
  seat: string;
  salesHelp: string;
  salesSaved: string;
  sum: (value: string) => string;
  savePercents: string;
  salesAbout100: string;
  weekdays: string[];
  managersHelp: string;
  managerNamePh: string;
  newCodePh: string;
  longIdle: string;
  addManager: string;
  owner: string;
  manager: string;
  active: string;
  inactive: string;
  longUnlock: string;
  replacementCode: string;
  rotateCode: string;
  deactivate: string;
  activate: string;
  makeManager: string;
  makeOwner: string;
  day: string;
  savedPosition: (position: string) => string;
  notOneBoard: string;
};

const es: BackOfficeCopy = {
  loading: "Cargando oficina…",
  title: "Oficina",
  intro: "Editor de estaciones, personas, tareas, el plano de asientos y los porcentajes de ventas por hora. Las tablets se quedan en el tablero.",
  managerCode: "Código de gerente",
  wrongCode: "Código de gerente incorrecto",
  enter: "Entrar",
  floorBoard: "Tablero",
  session: (name) => `${name} · sesión de escritorio · los códigos se quedan ocultos`,
  logOut: "Salir",
  tabs: {
    stations: "Estaciones",
    people: "Personas",
    tareas: "Tareas",
    seats: "Plano",
    sales: "Ventas %",
    habilidades: "Habilidades",
    managers: "Gerentes",
    cambios: "Cambios",
    positions: "Puestos",
    turnos: "Turnos",
  },
  ownerRequired: "Se necesita el código de dueño",
  savedStation: (id) => `Guardado ${id}`,
  createdStation: (id) => `Creada ${id}`,
  stationsHelp: "Nombres, colores, códigos cortos y tablero. Sigue una persona por estación (máximo 1).",
  save: "Guardar",
  addStation: "Agregar estación",
  labelPh: "Nombre",
  codePh: "Código",
  personAdded: "Persona agregada",
  firstPh: "Nombre",
  lastPh: "Apellido",
  addPerson: "Agregar persona",
  savedTarea: (id) => `Guardada la tarea ${id}`,
  seated: "Sentado",
  seatsHelp: "Las mismas reglas del piso: una persona por estación, y solo durante su turno.",
  seat: "Sentar",
  salesHelp: "Cada número es la parte de las ventas del día en esa hora, no un conteo de pedidos. El día tiene que sumar cerca del 100%.",
  salesSaved: "Porcentajes de ventas guardados",
  sum: (value) => `Suma ${value}%`,
  savePercents: "Guardar porcentajes",
  salesAbout100: "Los porcentajes de ventas tienen que sumar cerca del 100% del día.",
  weekdays: ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"],
  managersHelp: "Agrega un gerente, cambia un código o apaga un acceso viejo aquí. Los códigos solo se envían para crear o rotar el acceso; esta página no carga los códigos guardados.",
  managerNamePh: "Nombre del gerente",
  newCodePh: "Código nuevo",
  longIdle: "Se queda abierto 10 minutos (planeación)",
  addManager: "Agregar gerente",
  owner: "dueño",
  manager: "gerente",
  active: "activo",
  inactive: "inactivo",
  longUnlock: "desbloqueo de 10 min",
  replacementCode: "Código de reemplazo",
  rotateCode: "Rotar código",
  deactivate: "Desactivar",
  activate: "Activar",
  makeManager: "Hacer gerente",
  makeOwner: "Hacer dueño",
  day: "Día",
  savedPosition: (position) => `Guardado "${position}"`,
  notOneBoard: "(no está en un solo tablero — no se puede mapear)",
};

const en: BackOfficeCopy = {
  loading: "Loading back office…",
  title: "Back office",
  intro: "Desk editor for stations, people, tareas, the seat plan, and sales-by-hour percents. Floor tablets stay on the board.",
  managerCode: "Manager code",
  wrongCode: "Wrong manager code",
  enter: "Enter",
  floorBoard: "Floor board",
  session: (name) => `${name} · desk session · codes stay hidden`,
  logOut: "Log out",
  tabs: {
    stations: "Stations",
    people: "People",
    tareas: "Tareas",
    seats: "Seat plan",
    sales: "Sales %",
    habilidades: "Habilidades",
    managers: "Managers",
    cambios: "Cambios",
    positions: "Positions",
    turnos: "Turnos",
  },
  ownerRequired: "Owner code required",
  savedStation: (id) => `Saved ${id}`,
  createdStation: (id) => `Created ${id}`,
  stationsHelp: "Labels, colors, short codes, and board. One person per station stays on (max 1).",
  save: "Save",
  addStation: "Add station",
  labelPh: "Label",
  codePh: "Code",
  personAdded: "Person added",
  firstPh: "First",
  lastPh: "Last",
  addPerson: "Add person",
  savedTarea: (id) => `Saved tarea ${id}`,
  seated: "Seated",
  seatsHelp: "Same rules as the floor: one person per station, and only during their shift.",
  seat: "Seat",
  salesHelp: "Each number is that hour’s share of the day’s sales, not an order count. The day must add up to about 100%.",
  salesSaved: "Sales percents saved",
  sum: (value) => `Sum ${value}%`,
  savePercents: "Save percents",
  salesAbout100: "Sales percents must add up to about 100% of the day.",
  weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  managersHelp: "Add a manager, rotate a code, or deactivate old access here. Codes are sent only to create or rotate access; stored hashes are never loaded into this page.",
  managerNamePh: "Manager name",
  newCodePh: "New code",
  longIdle: "Stays unlocked 10 minutes (planning)",
  addManager: "Add manager",
  owner: "owner",
  manager: "manager",
  active: "active",
  inactive: "inactive",
  longUnlock: "10 min unlock",
  replacementCode: "Replacement code",
  rotateCode: "Rotate code",
  deactivate: "Deactivate",
  activate: "Activate",
  makeManager: "Make manager",
  makeOwner: "Make owner",
  day: "Day",
  savedPosition: (position) => `Saved "${position}"`,
  notOneBoard: "(not on one board — can't be mapped)",
};

export function backOfficeCopy(locale: Locale): BackOfficeCopy {
  return locale === "en" ? en : es;
}

export function presentBackOfficeError(message: string, copy: BackOfficeCopy): string {
  if (/about 100%/.test(message)) return copy.salesAbout100;
  return message;
}

const CopyContext = createContext<BackOfficeCopy>(es);

export function BackOfficeCopyProvider({
  copy,
  children,
}: {
  copy: BackOfficeCopy;
  children: ReactNode;
}) {
  return <CopyContext.Provider value={copy}>{children}</CopyContext.Provider>;
}

export function useBackOfficeCopy(): BackOfficeCopy {
  return useContext(CopyContext);
}
