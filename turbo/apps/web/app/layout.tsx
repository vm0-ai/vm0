// Root layout for the web application (e2e-auth validated without Playwright)
import type { Metadata } from "next";
import Script from "next/script";
import { getLocale } from "next-intl/server";
import {
  Noto_Sans,
  Fira_Code,
  Fira_Mono,
  JetBrains_Mono,
} from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import {
  getClerkFrontendApiHost,
  getClerkPublishableKey,
} from "../src/lib/shared/clerk-config";
import { getAllowedRedirectOrigins, getAppUrl } from "../src/lib/zero/url";
import { SafeGoogleOneTap } from "./components/SafeGoogleOneTap";
import { ThemeProvider } from "./components/ThemeProvider";
import { AttributionCapture } from "./components/AttributionCapture";
import { env } from "../src/env";
import "./globals.css";
import "./landing.css";
import "./blog.css";
import "./docs.css";
import "./use-cases.css";
import "./illustration.css";

const GOOGLE_ADS_ID = "AW-18144854014";
const LINKEDIN_PARTNER_ID = "9378804";

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

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL("https://www.vm0.ai"),
    title: {
      default: "VM0 - Your Trustworthy AI Teammate",
      template: "%s | VM0",
    },
    description:
      "Zero, your trustworthy AI teammate for real work. Connects to 100+ tools and does the work — reports, triage, outreach, research — in Slack or on the web.",
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
    authors: [{ name: "VM0", url: "https://www.vm0.ai" }],
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
      url: "https://www.vm0.ai",
      title: "VM0 - Your Trustworthy AI Teammate",
      description:
        "Zero, your trustworthy AI teammate for real work. Connects to 100+ tools and does the work — reports, triage, outreach, research — in Slack or on the web.",
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
        "Zero connects to 100+ tools and does the work. Reports, triage, outreach, research. In Slack or on the web.",
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Locale is derived via next-intl (set by middleware + i18n.ts request config).
  // Drives the <html lang> attribute so non-English pages are indexed correctly.
  const htmlLang = await getLocale();
  const clerkFapiHost = getClerkFrontendApiHost();
  const shouldLoadMarketingScripts = env().VERCEL_ENV === "production";

  return (
    <ClerkProvider
      publishableKey={getClerkPublishableKey()}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl={getAppUrl()}
      signUpFallbackRedirectUrl={getAppUrl()}
      allowedRedirectOrigins={getAllowedRedirectOrigins()}
    >
      <SafeGoogleOneTap redirectUrl={getAppUrl()} />
      <html lang={htmlLang} data-theme="dark" suppressHydrationWarning>
        <head>
          {shouldLoadMarketingScripts && (
            <>
              {/*
                Google Consent Mode v2 default-denied. Must run synchronously in
                <head> before gtag.js loads so Google itself respects consent and
                withholds cookies + tracking pings until the user opts in. Inline
                via dangerouslySetInnerHTML so it ships in SSR HTML with zero
                network round-trip — any async strategy (incl. beforeInteractive
                with src) loses the race against tag-manager bootstrap.
              */}
              <script
                id="google-consent-default"
                dangerouslySetInnerHTML={{
                  __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});`,
                }}
              />
              {/*
                Termly resource-blocker. beforeInteractive ensures Next.js places
                this in the SSR <head> ahead of client-injected tracking scripts
                so Termly's MutationObserver is live before gtag.js mounts.
                Previously loaded with afterInteractive, which raced gtag and let
                the Google Ads pixel + _gcl_au cookie fire before consent.
              */}
              <Script
                src="https://app.termly.io/resource-blocker/058a3478-08ac-4f2f-a9c4-5b357bbe7433"
                strategy="beforeInteractive"
              />
              <Script
                id="google-ads-tag"
                src={`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`}
                strategy="afterInteractive"
              />
              <Script id="google-ads-init" strategy="afterInteractive">
                {`gtag('js', new Date());gtag('config', '${GOOGLE_ADS_ID}');`}
              </Script>
            </>
          )}
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link
            rel="preconnect"
            href="https://fonts.gstatic.com"
            crossOrigin="anonymous"
          />
          {clerkFapiHost && (
            <link
              rel="preconnect"
              href={`https://${clerkFapiHost}`}
              crossOrigin="anonymous"
            />
          )}
          <link rel="dns-prefetch" href="https://plausible.io" />
          {/*
            Theme init must run synchronously in <head> before first paint to
            avoid a dark-mode flash. SSR renders <html data-theme="dark">, and
            this script flips it to the user's preferred theme before the
            browser paints. Inline via dangerouslySetInnerHTML so there is no
            network round-trip — an external <script src> (even with
            next/script beforeInteractive) can race first paint.
          */}
          <script
            id="theme-init"
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}else if(window.matchMedia("(prefers-color-scheme: light)").matches){document.documentElement.setAttribute("data-theme","light")}}catch(e){}})();`,
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
          className={`${notoSans.variable} ${firaCode.variable} ${firaMono.variable} ${jetBrainsMono.variable}`}
        >
          {/*
            JSON-LD must render as a native <script> tag in SSR HTML so Googlebot
            sees it on first-pass crawl. Next.js <Script> (default strategy:
            afterInteractive) injects scripts client-side and escapes payloads,
            which hides the structured data from first-wave indexing and most
            third-party validators.
          */}
          <script
            type="application/ld+json"
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: JSON.stringify({
                "@context": "https://schema.org",
                "@type": "Organization",
                name: "VM0",
                url: "https://www.vm0.ai",
                logo: "https://www.vm0.ai/assets/vm0-logo.svg",
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
          <script
            type="application/ld+json"
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: JSON.stringify({
                "@context": "https://schema.org",
                "@type": "WebSite",
                name: "VM0",
                url: "https://www.vm0.ai",
                description:
                  "Your trustworthy AI teammate. Works in Slack and on the web, for individuals and team collaboration.",
              }),
            }}
          />
          <script
            type="application/ld+json"
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: JSON.stringify({
                "@context": "https://schema.org",
                "@type": "SoftwareApplication",
                name: "VM0",
                applicationCategory: "BusinessApplication",
                operatingSystem: "Web, Linux, macOS, Windows",
                offers: {
                  "@type": "Offer",
                  price: "0",
                  priceCurrency: "USD",
                },
                description:
                  "Your trustworthy AI teammate. Works in Slack and on the web, for individuals and team collaboration.",
                url: "https://www.vm0.ai",
                image: "https://www.vm0.ai/og-image.png",
              }),
            }}
          />
          <ThemeProvider>
            <AttributionCapture />
            {children}
          </ThemeProvider>
          <Script
            src="https://api.dashboard.instatus.com/widget?host=status.vm0.ai&code=02c0ef5a&locale=en"
            strategy="lazyOnload"
          />
          {shouldLoadMarketingScripts && (
            <>
              <Script id="linkedin-insight-init" strategy="afterInteractive">
                {`
                  _linkedin_partner_id = "${LINKEDIN_PARTNER_ID}";
                  window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
                  window._linkedin_data_partner_ids.push(_linkedin_partner_id);
                `}
              </Script>
              <Script id="linkedin-insight-loader" strategy="afterInteractive">
                {`
                  (function(l) {
                    if (!l){window.lintrk = function(a,b){window.lintrk.q.push([a,b])};
                    window.lintrk.q=[]}
                    var s = document.getElementsByTagName("script")[0];
                    var b = document.createElement("script");
                    b.type = "text/javascript";b.async = true;
                    b.src = "https://snap.licdn.com/li.lms-analytics/insight.min.js";
                    s.parentNode.insertBefore(b, s);})(window.lintrk);
                `}
              </Script>
              {/*
                LinkedIn's no-JS tracking pixel must render as raw HTML inside
                <noscript> — next/image and the @next/next/no-img-element rule
                both rely on client-side JS, which by definition cannot run here.
                dangerouslySetInnerHTML keeps the pixel in pure HTML and stays
                consistent with the JSON-LD blocks above.
              */}
              <noscript
                dangerouslySetInnerHTML={{
                  __html: `<img height="1" width="1" style="display:none;" alt="" src="https://px.ads.linkedin.com/collect/?pid=${LINKEDIN_PARTNER_ID}&fmt=gif" />`,
                }}
              />
            </>
          )}
        </body>
      </html>
    </ClerkProvider>
  );
}
