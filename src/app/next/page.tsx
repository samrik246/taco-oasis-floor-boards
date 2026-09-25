import type { Metadata } from "next";
import { NextOrders } from "@/components/next/NextOrders";

export const metadata: Metadata = {
  title: "Tacos4Groups · Next",
};

export default function NextPage() {
  return <NextOrders />;
}
