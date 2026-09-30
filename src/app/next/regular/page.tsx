import type { Metadata } from "next";
import { RegularOrders } from "@/components/regular/RegularOrders";

export const metadata: Metadata = {
  title: "Regulares · Pedidos en línea",
};

export default function RegularPage() {
  return <RegularOrders />;
}
