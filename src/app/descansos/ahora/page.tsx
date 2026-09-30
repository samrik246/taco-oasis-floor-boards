import { Suspense } from "react";
import { AhoraScreen } from "@/components/breaks/AhoraScreen";

export default function DescansosAhoraPage() {
  return (
    <Suspense fallback={<div className="p-8 text-lg font-bold">BREAK</div>}>
      <AhoraScreen />
    </Suspense>
  );
}
