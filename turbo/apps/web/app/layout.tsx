// Root layout for the web application (e2e-auth validated without Playwright)
import type { Metadata } from "next";
import Script from "next/script";
import {
  Noto_Sans,
  Instrument_Sans,
  Fira_Code,
  Fira_Mono,
  JetBrains_Mono,
} from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { getClerkPublishableKey } from "../src/lib/shared/clerk-config";
import { getAppUrl } from "../src/lib/zero/url";
import { ThemeProvider } from "./components/ThemeProvider";
import { HtmlLangSetter } from "./components/HtmlLangSetter";
import { env } from "../src/env";
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

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-instrument-sans",
  display: "swap",
  preload: false,
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

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL("https://vm0.ai"),
    title: {
      default: "VM0 - Your Trustworthy AI Teammate",
      template: "%s | VM0",
    },
    description:
      "Meet Zero, your AI teammate that works in Slack and on the web. Secure, intelligent, and built for individuals and teams to do more together.",
    keywords: [
      "AI teammate",
      "AI agents",
      "Slack AI",
      "AI assistant",
      "team collaboration",
      "AI automation",
      "secure AI",
      "VM0",
      "Zero AI",
      "AI for teams",
      "AI productivity",
      "workflow automation",
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
    alternates: {},
    verification: {
      google: env().GOOGLE_SITE_VERIFICATION,
    },
    openGraph: {
      type: "website",
      locale: "en_US",
      url: "https://vm0.ai",
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Meet Zero, your AI teammate that works in Slack and on the web. Secure, intelligent, and built for individuals and teams to do more together.",
      siteName: "VM0",
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
      card: "summary_large_image",
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Meet Zero, your AI teammate that works in Slack and on the web. Secure, intelligent, and built for teams.",
      images: ["/og-image.png"],
      creator: "@vm0_ai",
      site: "@vm0_ai",
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
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      publishableKey={getClerkPublishableKey()}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl={getAppUrl()}
      signUpFallbackRedirectUrl={getAppUrl()}
      allowedRedirectOrigins={[getAppUrl()]}
    >
      <html lang="en" data-theme="dark" suppressHydrationWarning>
        <head>
          <Script
            src="https://app.termly.io/resource-blocker/058a3478-08ac-4f2f-a9c4-5b357bbe7433"
            strategy="afterInteractive"
          />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link
            rel="preconnect"
            href="https://fonts.gstatic.com"
            crossOrigin="anonymous"
          />
          <link rel="dns-prefetch" href="https://plausible.io" />
          <Script
            id="theme-init"
            strategy="beforeInteractive"
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}else if(window.matchMedia('(prefers-color-scheme: light)').matches){document.documentElement.setAttribute('data-theme','light')}}catch(e){}})()`,
            }}
          />
          {env().NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL && (
            <>
              <Script
                src={env().NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL}
                strategy="afterInteractive"
                async
              />
              <Script id="plausible-init" strategy="afterInteractive">
                {`window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init({transformRequest:function(p){p.u=p.u.replace(/\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'/:id');return p}})`}
              </Script>
            </>
          )}
        </head>
        <body
          className={`${notoSans.variable} ${instrumentSans.variable} ${firaCode.variable} ${firaMono.variable} ${jetBrainsMono.variable}`}
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
                  "Your trustworthy AI teammate. Works in Slack and on the web, for individuals and team collaboration.",
                email: "support@vm0.ai",
                foundingDate: "2025",
                sameAs: [
                  "https://twitter.com/vm0_ai",
                  "https://github.com/vm0-ai",
                  "https://github.com/vm0-ai/vm0",
                ],
                contactPoint: {
                  "@type": "ContactPoint",
                  email: "support@vm0.ai",
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
                  "Your trustworthy AI teammate. Works in Slack and on the web, for individuals and team collaboration.",
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
                  "Your trustworthy AI teammate. Works in Slack and on the web, for individuals and team collaboration.",
                url: "https://vm0.ai",
                image: "https://vm0.ai/og-image.png",
              }),
            }}
          />
          <HtmlLangSetter />
          <ThemeProvider>{children}</ThemeProvider>
          <Script
            src="https://api.dashboard.instatus.com/widget?host=status.vm0.ai&code=02c0ef5a&locale=en"
            strategy="lazyOnload"
          />
        </body>
      </html>
    </ClerkProvider>
  );
}
