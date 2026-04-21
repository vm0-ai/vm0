import type { Metadata } from "next";
import { PrivacyPolicyClient } from "./PrivacyPolicyClient";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "VM0 Privacy Policy — how we collect, use, and protect your data.",
  alternates: {
    canonical: "https://www.vm0.ai/privacy-policy",
  },
  robots: {
    index: true,
    follow: false,
  },
};

export default function PrivacyPolicyPage() {
  return <PrivacyPolicyClient />;
}
