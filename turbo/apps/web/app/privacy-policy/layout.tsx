import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "VM0 Privacy Policy — how we collect, use, and protect your data.",
  alternates: {
    canonical: "https://vm0.ai/privacy-policy",
  },
  robots: {
    index: true,
    follow: false,
  },
};

export default function PrivacyPolicyLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
