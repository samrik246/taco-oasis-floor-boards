import { Suspense } from "react";
import { DescansosScreen } from "@/components/breaks/DescansosScreen";

export default function DescansosPage() {
  return (
    <Suspense fallback={<div className="p-8 text-lg font-bold">BREAK</div>}>
      <DescansosScreen />
    </Suspense>
  );
}
