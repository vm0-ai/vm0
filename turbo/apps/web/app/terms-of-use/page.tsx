import type { Metadata } from "next";
import TermsOfUseClient from "./TermsOfUseClient";

export const metadata: Metadata = {
  title: "Terms of Use",
  description:
    "VM0 Terms of Use — the rules and conditions governing use of our platform.",
  alternates: {
    canonical: "https://www.vm0.ai/terms-of-use",
  },
  robots: {
    index: true,
    follow: false,
  },
};

export default function TermsOfUsePage() {
  return <TermsOfUseClient />;
}
