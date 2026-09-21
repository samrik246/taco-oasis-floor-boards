"use client";

import { useSearchParams } from "next/navigation";
import { FloorBoard } from "@/components/board/FloorBoard";
import { WallBoard } from "@/components/board/WallBoard";

export function FloorEntry() {
  const params = useSearchParams();
  const wall = params.get("wall") === "1" || params.get("wall") === "true";
  if (wall) return <WallBoard />;
  return <FloorBoard />;
}
