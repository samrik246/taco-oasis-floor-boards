import { Suspense } from "react";
import { BackOffice } from "@/components/admin/BackOffice";

export default function BackOfficePage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 font-semibold text-neutral-700">Loading back office…</div>
      }
    >
      <BackOffice />
    </Suspense>
  );
}
