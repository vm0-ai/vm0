import type { Metadata } from "next";
import { SupportPageClient } from "./SupportPageClient";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Get help with VM0 — contact support by email, chat on Discord, file issues on GitHub, or check service status.",
  alternates: {
    canonical: "https://www.vm0.ai/support",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function SupportPage() {
  return <SupportPageClient />;
}
