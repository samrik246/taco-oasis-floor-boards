import { Suspense } from "react";
import { FloorEntry } from "@/components/board/FloorEntry";

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center p-8 font-semibold text-neutral-700">
          Loading floor board…
        </div>
      }
    >
      <FloorEntry />
    </Suspense>
  );
}
