import "@/app/global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { Noto_Sans } from "next/font/google";
import { createMetadata, baseUrl } from "@/lib/metadata";

const notoSans = Noto_Sans({
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata = createMetadata({
  metadataBase: baseUrl,
  title: {
    default: "VM0 Documentation",
    template: "%s | VM0 Docs",
  },
  description: "Build agents and automate workflows with natural language",
  keywords: [
    "VM0",
    "AI agents",
    "documentation",
    "agent development",
    "CLI agents",
    "sandbox",
    "natural language",
    "agent skills",
  ],
  robots: {
    index: true,
    follow: true,
  },
});

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={notoSans.className} suppressHydrationWarning>
      <head>
        {process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL && (
          <>
            <script src={process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL} defer />
            <script
              dangerouslySetInnerHTML={{
                __html: `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init({transformRequest:function(p){p.u=p.u.replace(/\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'/:id');return p}})`,
              }}
            />
          </>
        )}
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
        <script
          src="https://api.dashboard.instatus.com/widget?host=status.vm0.ai&code=02c0ef5a&locale=en"
          defer
        />
      </body>
    </html>
  );
}
