"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { readLocalePreference, saveLocalePreference } from "@/lib/locale-preference";
import type { Locale } from "@/lib/i18n";

/** Public navigation, like the existing floor entry. Privileged screens keep their own guards. */
export function Inicio() {
  const params = useSearchParams();
  const board = params.get("board") === "caja" ? "caja" : "cocina";
  const [locale, setLocale] = useState<Locale>("es");
  useEffect(() => { const id = window.setTimeout(() => setLocale(readLocalePreference()), 0); return () => clearTimeout(id); }, []);
  const es = locale === "es";
  const entries = [
    { id: "floor", href: `/?board=${board}`, label: es ? "Tablero" : "Floor board" },
    { id: "wall", href: `/?wall=1&board=${board}`, label: es ? "Tablero de pared" : "Wall board" },
    { id: "next", href: "/next", label: es ? "Próximos · NEXT" : "Upcoming · NEXT" },
    { id: "break", href: `/descansos?board=${board}&from=inicio`, label: "BREAK" },
    { id: "now", href: `/descansos/ahora?board=${board}&from=inicio`, label: es ? "Ahora en BREAK" : "On BREAK now" },
    { id: "admin", href: "/back-office", label: es ? "Administración · Acceso de gerente" : "Administration · Manager sign-in" },
  ];
  return <main className="mx-auto min-h-dvh w-full max-w-4xl space-y-6 bg-white p-4 text-neutral-950" data-testid="inicio">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-3xl font-bold">Inicio · Home</h1>
      <button type="button" className="min-h-11 rounded border-2 px-3 font-bold" data-testid="inicio-locale" onClick={() => { const next = es ? "en" : "es"; saveLocalePreference(next); setLocale(next); }}>{es ? "English" : "Español"}</button>
    </header>
    <nav aria-label={es ? "Área" : "Area"} className="flex gap-3">
      {(["caja", "cocina"] as const).map(value => <Link key={value} href={`/inicio?board=${value}`} aria-current={board === value ? "page" : undefined} className={`min-h-11 rounded border-2 p-3 font-bold ${board === value ? "bg-neutral-900 text-white" : ""}`}>{value === "caja" ? es ? "Caja" : "Cashiers" : es ? "Cocina" : "Kitchen"}</Link>)}
    </nav>
    <nav aria-label={es ? "Destinos" : "Destinations"} className="grid gap-3 sm:grid-cols-2">
      {entries.map(entry => <Link key={entry.id} href={entry.href} data-testid={`inicio-${entry.id}`} className="flex min-h-20 items-center rounded-lg border-2 border-neutral-700 p-4 text-xl font-bold underline">{entry.label}</Link>)}
    </nav>
    <p>{es ? "Los borradores retenidos del tablero se conservan. Cada área mantiene su acceso de gerente; Administración pide su propio acceso." : "Retained board drafts are preserved. Each area keeps its manager access; Administration requires its own sign-in."}</p>
  </main>;
}
