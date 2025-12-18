import type { Metadata } from "next";
import Script from "next/script";
import { Noto_Sans, Fira_Code, Fira_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { getClerkPublishableKey } from "../src/lib/clerk-config";
import { ThemeProvider } from "./components/ThemeProvider";
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
  metadataBase: new URL("https://vm0.ai"),
  title: {
    default: "VM0 - The Modern Runtime for Agent-Native Development",
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
    title: "VM0 - The Modern Runtime for Agent-Native Development",
    description:
      "Infrastructure for AI agents, not workflows. VM0's built-in sandbox gives you everything you need to design, run, and iterate on modern agents.",
    siteName: "VM0",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "VM0 - The Modern Runtime for Agent-Native Development",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "VM0 - The Modern Runtime for Agent-Native Development",
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
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider publishableKey={getClerkPublishableKey()}>
      <html lang="en" data-theme="dark" suppressHydrationWarning>
        <head>
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
                  "The modern runtime for agent-native development. Infrastructure for AI agents, not workflows.",
                email: "contact@vm0.ai",
                foundingDate: "2025",
                sameAs: [
                  // Add social media links if available
                  // "https://twitter.com/vm0_ai",
                  // "https://github.com/vm0",
                  // "https://linkedin.com/company/vm0",
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
                description: "The modern runtime for agent-native development",
                potentialAction: {
                  "@type": "SearchAction",
                  target: "https://vm0.ai/search?q={search_term_string}",
                  "query-input": "required name=search_term_string",
                },
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
                  "The modern runtime for agent-native development. Infrastructure for AI agents, not workflows.",
                url: "https://vm0.ai",
                image: "https://vm0.ai/og-image.png",
              }),
            }}
          />
          <ThemeProvider>{children}</ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
