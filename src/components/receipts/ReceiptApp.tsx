"use client";

import Link from "next/link";
import { useState } from "react";
import { ManagerUnlockModal } from "@/components/board/ManagerUnlockModal";
import { useManagerIdle, useManagerSession } from "@/components/board/useManagerSession";
import { messagesFor } from "@/lib/i18n";
import { ReceiptWorkspace } from "./ReceiptWorkspace";
import { words, type ReceiptLocale } from "./copy";

export function ReceiptApp() {
  const session = useManagerSession();
  useManagerIdle({ idleMs: session.idleMs, onIdle: session.lock, active: session.isManager });
  const [unlock, setUnlock] = useState(false);
  const [locale, setLocale] = useState<ReceiptLocale>("es");
  const t = (es: string, en: string) => words(locale, es, en);
  return <main className="min-h-dvh bg-neutral-50 p-4 text-xl text-neutral-950" style={{ colorScheme: "light" }}>
    <header className="mb-5 flex flex-wrap items-center gap-4">
      <h1 className="text-3xl font-black">{t("Impresoras de recibos", "Receipt printers")}</h1>
      <Link className="min-h-14 rounded border-2 p-3" href="/next">{t("Volver", "Back")}</Link>
      <button className="min-h-14 rounded border-2 p-3" onClick={() => setLocale((l) => l === "es" ? "en" : "es")}>{locale === "es" ? "English" : "Español"}</button>
      {session.manager && <button className="min-h-14 rounded border-2 p-3" onClick={session.lock}>{t("Salir de gerente", "Manager sign out")}</button>}
    </header>
    {session.manager ? <ReceiptWorkspace key={session.manager.id} manager={session.manager} locale={locale} onLock={session.lock} /> : <section>
      <p>{t("Se necesita acceso de gerente", "Manager access required")}</p>
      <button className="my-4 min-h-14 rounded-lg border-2 bg-white p-4 font-bold" onClick={() => setUnlock(true)}>{t("Iniciar sesión de gerente", "Manager sign in")}</button>
    </section>}
    <ManagerUnlockModal open={unlock} t={messagesFor(locale)} onCancel={() => setUnlock(false)} onUnlocked={(manager, idleMs) => { session.unlock(manager, idleMs); setUnlock(false); }} />
  </main>;
}
