import { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { notFound } from "next/navigation";
import { locales, type Locale } from "@vm0/i18n";
import type { Metadata } from "next";

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

async function getMessages(locale: Locale) {
  switch (locale) {
    case "en":
      return (await import("@vm0/i18n/messages/en.json")).default;
    case "de":
      return (await import("@vm0/i18n/messages/de.json")).default;
    case "ja":
      return (await import("@vm0/i18n/messages/ja.json")).default;
    case "es":
      return (await import("@vm0/i18n/messages/es.json")).default;
    default:
      return (await import("@vm0/i18n/messages/en.json")).default;
  }
}

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

  // Load messages from shared i18n package
  const messages = await getMessages(locale as Locale);

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {props.children}
    </NextIntlClientProvider>
  );
}
