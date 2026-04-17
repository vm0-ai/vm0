import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import SiteHeader from "../components/SiteHeader";
import enMessages from "../../messages/en.json";

export default function SupportLayout({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SiteHeader />
      {children}
    </NextIntlClientProvider>
  );
}
