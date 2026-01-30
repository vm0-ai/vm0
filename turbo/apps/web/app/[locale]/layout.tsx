import { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { notFound } from "next/navigation";
import { locales, type Locale } from "../../i18n";
import type { Metadata } from "next";

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
      url: `${baseUrl}/${locale}`,
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 - Build agents and automate workflows with natural language",
        },
      ],
    },
    twitter: {
      images: ["/og-image.png"],
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

  // Load messages directly for the current locale
  const messages = (await import(`../../messages/${locale}.json`)).default;

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {props.children}
    </NextIntlClientProvider>
  );
}
