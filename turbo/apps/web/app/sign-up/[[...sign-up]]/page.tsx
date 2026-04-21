import type { Metadata } from "next";
import { SignUpClient } from "./SignUpClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SignUpPage() {
  return <SignUpClient />;
}
