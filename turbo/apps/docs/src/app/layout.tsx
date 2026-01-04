import "@/app/global.css";
import { RootProvider } from "fumadocs-ui/provider";
import { Noto_Sans } from "next/font/google";

const notoSans = Noto_Sans({
  subsets: ["latin"],
  weight: ["400", "700"],
});

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={notoSans.className} suppressHydrationWarning>
      <head>
        <script
          defer
          data-domain="vm0.ai"
          src="https://plausible.io/js/pa-eEj_2G8vS8xPlTUzW2A3U.js"
        ></script>
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
