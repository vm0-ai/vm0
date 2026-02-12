import type { Metadata } from "next";
import Script from "next/script";
import {
  Noto_Sans,
  Fira_Code,
  Fira_Mono,
  JetBrains_Mono,
} from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { getClerkPublishableKey } from "../src/lib/clerk-config";
import { isSelfHosted } from "../src/env";
import { ThemeProvider } from "./components/ThemeProvider";
import "./globals.css";
import "./landing.css";
import "./blog.css";

const notoSans = Noto_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-noto-sans",
  display: "swap",
  preload: true,
});

const firaCode = Fira_Code({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-fira-code",
  display: "swap",
  preload: false,
});

const firaMono = Fira_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-fira-mono",
  display: "swap",
  preload: false,
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains-mono",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  metadataBase: new URL("https://vm0.ai"),
  title: {
    default: "VM0 - Build agents and automate workflows with natural language",
    template: "%s | VM0",
  },
  description:
    "Infrastructure for AI agents, not workflows. VM0's built-in sandbox gives you everything you need to design, run, and iterate on modern agents.",
  keywords: [
    "AI agents",
    "agent development",
    "agent runtime",
    "sandbox environment",
    "CLI agents",
    "Claude Code",
    "agent infrastructure",
    "natural language agents",
    "VM0",
    "agent sandbox",
    "AI runtime",
    "agent deployment",
  ],
  authors: [{ name: "VM0", url: "https://vm0.ai" }],
  creator: "VM0",
  publisher: "VM0",
  applicationName: "VM0",
  referrer: "origin-when-cross-origin",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  alternates: {
    canonical: "https://vm0.ai",
  },
  verification: {
    // Add verification codes when available
    // google: "your-google-verification-code",
    // yandex: "your-yandex-verification-code",
    // bing: "your-bing-verification-code",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://vm0.ai",
    title: "VM0 - Build agents and automate workflows with natural language",
    description:
      "Infrastructure for AI agents, not workflows. VM0's built-in sandbox gives you everything you need to design, run, and iterate on modern agents.",
    siteName: "VM0",
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
    card: "summary_large_image",
    title: "VM0 - Build agents and automate workflows with natural language",
    description:
      "Infrastructure for AI agents, not workflows. Build and iterate on modern agents with VM0's built-in sandbox.",
    images: ["/og-image.png"],
    creator: "@vm0_ai",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const content = (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {!isSelfHosted() && (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link
              rel="preconnect"
              href="https://fonts.gstatic.com"
              crossOrigin="anonymous"
            />
            <link rel="dns-prefetch" href="https://plausible.io" />
          </>
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `
                (function() {
                  try {
                    var theme = localStorage.getItem('theme');
                    if (theme === 'light' || theme === 'dark') {
                      document.documentElement.setAttribute('data-theme', theme);
                    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
                      document.documentElement.setAttribute('data-theme', 'light');
                    }
                  } catch (e) {}
                })();
              `,
          }}
        />
        {!isSelfHosted() && (
          <>
            <Script
              src="https://plausible.io/js/pa-eEj_2G8vS8xPlTUzW2A3U.js"
              data-domain="vm0.ai"
              strategy="afterInteractive"
              async
            />
            <Script id="plausible-init" strategy="afterInteractive">
              {`
                window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
                plausible.init({domain:"vm0.ai"})
              `}
            </Script>
          </>
        )}
      </head>
      <body
        className={`${notoSans.variable} ${firaCode.variable} ${firaMono.variable} ${jetBrainsMono.variable}`}
      >
        {!isSelfHosted() && (
          <>
            <Script
              id="json-ld"
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify({
                  "@context": "https://schema.org",
                  "@type": "Organization",
                  name: "VM0",
                  url: "https://vm0.ai",
                  logo: "https://vm0.ai/assets/vm0-logo.svg",
                  description:
                    "Build agents and automate workflows with natural language. Infrastructure for AI agents, not workflows.",
                  email: "contact@vm0.ai",
                  foundingDate: "2025",
                  sameAs: [
                    "https://twitter.com/vm0_ai",
                    "https://github.com/vm0-ai",
                    "https://github.com/vm0-ai/vm0",
                  ],
                  contactPoint: {
                    "@type": "ContactPoint",
                    email: "contact@vm0.ai",
                    contactType: "customer support",
                  },
                }),
              }}
            />
            <Script
              id="json-ld-website"
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify({
                  "@context": "https://schema.org",
                  "@type": "WebSite",
                  name: "VM0",
                  url: "https://vm0.ai",
                  description:
                    "Build agents and automate workflows with natural language",
                }),
              }}
            />
            <Script
              id="json-ld-software"
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify({
                  "@context": "https://schema.org",
                  "@type": "SoftwareApplication",
                  name: "VM0",
                  applicationCategory: "DeveloperApplication",
                  operatingSystem: "Web, Linux, macOS, Windows",
                  offers: {
                    "@type": "Offer",
                    price: "0",
                    priceCurrency: "USD",
                  },
                  description:
                    "Build agents and automate workflows with natural language. Infrastructure for AI agents, not workflows.",
                  url: "https://vm0.ai",
                  image: "https://vm0.ai/og-image.png",
                }),
              }}
            />
          </>
        )}
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );

  if (isSelfHosted()) {
    return content;
  }

  return (
    <ClerkProvider
      publishableKey={getClerkPublishableKey()}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
    >
      {content}
    </ClerkProvider>
  );
}
