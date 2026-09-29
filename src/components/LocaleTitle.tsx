"use client";

import { useEffect } from "react";
import { LOCALE_EVENT, readLocalePreference } from "@/lib/locale-preference";

/** Browser tab title follows the device language. Spanish says Tableros. */
export function LocaleTitle() {
  useEffect(() => {
    function apply() {
      const locale = readLocalePreference();
      document.title = locale === "es" ? "Tableros" : "Floor Boards";
      document.documentElement.lang = locale;
    }
    apply();
    window.addEventListener(LOCALE_EVENT, apply);
    window.addEventListener("storage", apply);
    return () => {
      window.removeEventListener(LOCALE_EVENT, apply);
      window.removeEventListener("storage", apply);
    };
  }, []);
  return null;
}
