import { ReactNode } from "react";
import { notFound } from "next/navigation";
import { locales, type Locale } from "../../i18n";
import type { Metadata } from "next";
import { IntlProviderWrapper } from "../components/IntlProviderWrapper";

// Static imports for all message files to ensure proper bundling
import enMessages from "../../messages/en.json";
import deMessages from "../../messages/de.json";
import jaMessages from "../../messages/ja.json";
import esMessages from "../../messages/es.json";

// Static message map for reliable bundling
const messagesByLocale: Record<Locale, Record<string, string>> = {
  en: enMessages,
  de: deMessages,
  ja: jaMessages,
  es: esMessages,
};

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;
  const locale = params.locale;

  const localeNames: Record<string, string> = {
    en: "en_US",
    de: "de_DE",
    es: "es_ES",
    ja: "ja_JP",
  };

  const baseUrl = "https://vm0.ai";
  const languages: Record<string, string> = {};

  locales.forEach((loc) => {
    languages[loc] = `${baseUrl}/${loc}`;
  });

  return {
    alternates: {
      canonical: `${baseUrl}/${locale}`,
      languages,
    },
    openGraph: {
      locale: localeNames[locale] || "en_US",
      alternateLocale: locales
        .filter((loc) => loc !== locale)
        .map((loc) => localeNames[loc])
        .filter((name): name is string => name !== undefined),
    },
  };
}

export default async function LocaleLayout(props: Props) {
  const params = await props.params;
  const locale = params.locale;

  // Validate locale
  if (!locales.includes(locale as Locale)) {
    notFound();
  }

  // Get messages from static map
  const messages = messagesByLocale[locale as Locale];

  return (
    <IntlProviderWrapper locale={locale} messages={messages}>
      {props.children}
    </IntlProviderWrapper>
  );
}
