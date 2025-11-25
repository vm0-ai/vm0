import type { Metadata } from "next";
import Script from "next/script";
import { Noto_Sans, Fira_Code, Fira_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { getClerkPublishableKey } from "../src/lib/clerk-config";
import "./globals.css";
import "./landing.css";

const notoSans = Noto_Sans({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-noto-sans",
});

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-fira-code",
});

const firaMono = Fira_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-fira-mono",
});

export const metadata: Metadata = {
  title: "VM0 - Modern Infrastructure for Agent Development",
  description:
    "Build and evolve AI agents, just natural language. VM0 gives you a built-in sandbox with everything needed to build modern agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider publishableKey={getClerkPublishableKey()}>
      <html lang="en">
        <head>
          <Script
            src="https://plausible.io/js/pa-eEj_2G8vS8xPlTUzW2A3U.js"
            strategy="afterInteractive"
            async
          />
          <Script id="plausible-init" strategy="afterInteractive">
            {`
              window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
              plausible.init()
            `}
          </Script>
        </head>
        <body
          className={`${notoSans.variable} ${firaCode.variable} ${firaMono.variable}`}
        >
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
