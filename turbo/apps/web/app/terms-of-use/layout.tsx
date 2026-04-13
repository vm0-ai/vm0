import type { Metadata } from "next";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import SiteHeader from "../components/SiteHeader";
import enMessages from "../../messages/en.json";

export const metadata: Metadata = {
  title: "Terms of Use",
  description:
    "VM0 Terms of Use — the rules and conditions governing use of our platform.",
  alternates: {
    canonical: "https://www.vm0.ai/terms-of-use",
  },
  robots: {
    index: true,
    follow: false,
  },
};

export default function TermsOfUseLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SiteHeader />
      {children}
    </NextIntlClientProvider>
  );
}
