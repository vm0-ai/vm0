import type { Metadata } from "next";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import SiteHeader from "../components/SiteHeader";
import enMessages from "../../messages/en.json";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "VM0 Privacy Policy — how we collect, use, and protect your data.",
  alternates: {
    canonical: "https://www.vm0.ai/privacy-policy",
  },
  robots: {
    index: true,
    follow: false,
  },
};

export default function PrivacyPolicyLayout({
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
