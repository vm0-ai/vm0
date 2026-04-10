"use client";

import { useEffect } from "react";
import { NextIntlClientProvider } from "next-intl";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import enMessages from "../../messages/en.json";

export default function PrivacyPolicyClient() {
  useEffect(() => {
    if (document.getElementById("termly-jssdk")) return;
    const script = document.createElement("script");
    script.id = "termly-jssdk";
    script.src = "https://app.termly.io/embed-policy.min.js";
    document.body.appendChild(script);
  }, []);

  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div className="landing-page min-h-screen bg-[hsl(var(--gray-0))] text-[hsl(var(--foreground))]">
        <div className="header-container">
          <Navbar />
        </div>

        <main className="px-6 pb-20 pt-[calc(var(--total-header-height)+48px)] md:pb-28 md:pt-[calc(var(--total-header-height)+72px)]">
          <div className="termly-embed-wrapper mx-auto max-w-2xl">
            <div
              {...({
                name: "termly-embed",
              } as React.HTMLAttributes<HTMLDivElement>)}
              data-id="e2483c7f-905a-4618-b026-94f823ff2332"
            />
          </div>
        </main>

        <Footer />
      </div>
    </NextIntlClientProvider>
  );
}
