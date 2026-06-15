import type { Metadata } from "next";
import { SignInTokenClient } from "./SignInTokenClient";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function SignInTokenPage() {
  return <SignInTokenClient />;
}
