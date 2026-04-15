import { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { notFound } from "next/navigation";
import { locales, type Locale } from "../../i18n";
import SiteHeader from "../components/SiteHeader";
import { buildLocaleAlternates } from "../lib/seo/alternates";
import type { Metadata } from "next";

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const params = await props.params;

  if (!locales.includes(params.locale as Locale)) {
    return {};
  }

  const locale = params.locale as Locale;

  const localeNames: Record<string, string> = {
    en: "en_US",
    de: "de_DE",
    es: "es_ES",
    ja: "ja_JP",
  };

  // Fallback hreflang for any route that doesn't provide page-level metadata.
  // All real pages under [locale] should override this via buildLocaleAlternates
  // with their own path so hreflang alternates point to the correct translation.
  const alternates = buildLocaleAlternates("", locale);
  const ogUrl = alternates.canonical;

  return {
    alternates,
    openGraph: {
      locale: localeNames[locale] || "en_US",
      alternateLocale: locales
        .filter((loc) => {
          return loc !== locale;
        })
        .map((loc) => {
          return localeNames[loc];
        })
        .filter((name): name is string => {
          return name !== undefined;
        }),
      url: ogUrl,
      images: [
        {
          url: "/og-image.png",
          width: 1200,
          height: 630,
          alt: "VM0 - Your Trustworthy AI Teammate",
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
      <SiteHeader />
      {props.children}
    </NextIntlClientProvider>
  );
}
