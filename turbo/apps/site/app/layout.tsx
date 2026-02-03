import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://vm0.ai"),
  title: "VM0 - Build agents and automate workflows with natural language",
  description:
    "Infrastructure for AI agents, not workflows. VM0's built-in sandbox gives you everything you need to design, run, and iterate on modern agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
