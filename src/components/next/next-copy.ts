import type { Locale } from "@/lib/i18n";
import type { FulfillType } from "@/lib/upcoming/fence";

/** SQUARE NEXT copy. Spanish first, as the cocina board is. */
export const NEXT_COPY = {
  es: {
    title: "Tacos4Groups · Próximos",
    month: "Mes",
    week: "Semana",
    list: "Lista",
    today: "Hoy",
    prev: "Anterior",
    next: "Siguiente",
    refresh: "Actualizar",
    updated: "Actualizado",
    never: "Nunca",
    stale: "No se pudo leer C1. Estos pedidos pueden estar viejos.",
    heldBack: (n: number) =>
      `${n} ${n === 1 ? "pedido retenido" : "pedidos retenidos"} por la revisión de privacidad. Ver el ticket de C1.`,
    testData: "Datos de prueba",
    empty: "No hay pedidos próximos.",
    off: "Próximos está apagado en esta computadora.",
    columns: "Mostrar",
    guests: "Personas",
    fulfill: "Entrega/Recoger",
    ready: "Listo a las",
    modifiers: "Detalles",
    eventTime: "Hora del evento",
    date: "Fecha",
    lines: "Líneas de cocina",
    close: "Cerrar",
    backToList: "Volver a la lista",
    options: "Opciones",
    noOrdersDay: "Sin pedidos",
    checksEvery: "Se revisa cada 5 minutos.",
    lineCount: (n: number) => `${n} ${n === 1 ? "línea" : "líneas"}`,
    orderCount: (n: number) => `${n} ${n === 1 ? "pedido" : "pedidos"}`,
    confirm: "confirmar",
    back: "Tablero",
    weekdays: ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"],
    fulfillType: { PICKUP: "RECOGER", DELIVERY: "ENTREGA" } as Record<FulfillType, string>,
  },
  en: {
    title: "Tacos4Groups · Next",
    month: "Month",
    week: "Week",
    list: "List",
    today: "Today",
    prev: "Previous",
    next: "Next",
    refresh: "Refresh",
    updated: "Updated",
    never: "Never",
    stale: "Could not read C1. These orders may be old.",
    heldBack: (n: number) =>
      `${n} ${n === 1 ? "order" : "orders"} held back by the privacy check. See the C1 ticket.`,
    testData: "Test data",
    empty: "No upcoming orders.",
    off: "Next is off on this computer.",
    columns: "Show",
    guests: "Guests",
    fulfill: "Pickup/Delivery",
    ready: "Ready by",
    modifiers: "Details",
    eventTime: "Event time",
    date: "Date",
    lines: "Kitchen lines",
    close: "Close",
    backToList: "Back to the list",
    options: "Options",
    noOrdersDay: "No orders",
    checksEvery: "Checked every 5 minutes.",
    lineCount: (n: number) => `${n} ${n === 1 ? "line" : "lines"}`,
    orderCount: (n: number) => `${n} ${n === 1 ? "order" : "orders"}`,
    confirm: "confirm",
    back: "Board",
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    fulfillType: { PICKUP: "PICKUP", DELIVERY: "DELIVERY" } as Record<FulfillType, string>,
  },
} satisfies Record<Locale, unknown>;

export type NextCopy = (typeof NEXT_COPY)["es"];

/** Guests are C1's estimate, never final: every surface prints the label. */
export function guestsText(guests: number, t: NextCopy): string {
  return `${guests} (${t.confirm})`;
}
