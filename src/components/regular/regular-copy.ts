import type { Locale } from "@/lib/i18n";
import type { RegularFulfillment, RegularState } from "@/lib/regular/fence";

/** Regulares copy. Spanish first, as Próximos is. */
export const REGULAR_COPY = {
  es: {
    title: "Regulares · Pedidos en línea",
    link: "Regulares",
    updated: "Actualizado",
    staleSince: (hhmm: string) => `Sin datos desde ${hhmm}`,
    staleNever: "Sin datos todavía",
    empty: "No hay pedidos regulares.",
    off: "Regulares está apagado en esta computadora.",
    ready: "Listo a las",
    ordered: "Pedido",
    heldBack: (n: number) => `${n} ${n === 1 ? "pedido retenido" : "pedidos retenidos"} por la revisión de privacidad.`,
    back: "Próximos",
    board: "Tablero",
    fulfillment: { PICKUP: "RECOGER", DELIVERY: "ENTREGA" } as Record<RegularFulfillment, string>,
    state: { OPEN: "Abierto", COMPLETED: "Completado", CANCELED: "Cancelado" } as Record<RegularState, string>,
    noName: "Sin nombre",
  },
  en: {
    title: "Regular · Online orders",
    link: "Regular",
    updated: "Updated",
    staleSince: (hhmm: string) => `No data since ${hhmm}`,
    staleNever: "No data yet",
    empty: "No regular orders.",
    off: "Regular orders are off on this computer.",
    ready: "Ready by",
    ordered: "Ordered",
    heldBack: (n: number) => `${n} ${n === 1 ? "order" : "orders"} held back by the privacy check.`,
    back: "Next",
    board: "Board",
    fulfillment: { PICKUP: "PICKUP", DELIVERY: "DELIVERY" } as Record<RegularFulfillment, string>,
    state: { OPEN: "Open", COMPLETED: "Completed", CANCELED: "Canceled" } as Record<RegularState, string>,
    noName: "No name",
  },
} as const satisfies Record<Locale, unknown>;

export type RegularCopy = (typeof REGULAR_COPY)[Locale];
