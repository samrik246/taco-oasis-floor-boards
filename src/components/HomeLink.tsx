"use client";

import Link from "next/link";

/** Navigation carries only the board selection; each destination owns its session. */
export function HomeLink({ board, className = "" }: { board?: string; className?: string }) {
  const href = board === "caja" || board === "cocina" ? `/inicio?board=${board}` : "/inicio";
  return <Link href={href} onNavigate={event => {
    const pending = document.querySelector<HTMLElement>('[data-paint-navigation-blocked="1"]');
    if (pending) { event.preventDefault(); pending.scrollIntoView({ block: "center" }); pending.focus({ preventScroll: true }); }
  }} className={`inline-flex min-h-11 items-center rounded border-2 border-current px-3 font-bold underline ${className}`} data-testid="inicio-link">Inicio · Home</Link>;
}
