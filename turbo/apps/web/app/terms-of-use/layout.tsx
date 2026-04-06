import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Terms of Use",
  description:
    "VM0 Terms of Use \u2014 the rules and conditions governing use of our platform.",
  alternates: {
    canonical: "https://vm0.ai/terms-of-use",
  },
  robots: {
    index: true,
    follow: false,
  },
};

export default function TermsOfUseLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
