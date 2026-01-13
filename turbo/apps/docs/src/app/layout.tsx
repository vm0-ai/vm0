import "@/app/global.css";
import { RootProvider } from "fumadocs-ui/provider";
import { Noto_Sans } from "next/font/google";
import Script from "next/script";
import type { Metadata } from "next";

const notoSans = Noto_Sans({
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.vm0.ai"),
  title: {
    default: "VM0 Documentation",
    template: "%s | VM0 Docs",
  },
  description: "Build agents and automate workflows with natural language",
  robots: {
    index: true,
    follow: true,
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={notoSans.className} suppressHydrationWarning>
      <head>
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
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
