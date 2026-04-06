"use client";

import { useParams } from "next/navigation";
import { useEffect } from "react";
import { locales, type Locale } from "../../i18n";

export function HtmlLangSetter() {
  const params = useParams<{ locale?: string }>();
  const locale = params.locale;

  useEffect(() => {
    if (locale && locales.includes(locale as Locale)) {
      document.documentElement.lang = locale;
    } else {
      document.documentElement.lang = "en";
    }
  }, [locale]);

  return null;
}
