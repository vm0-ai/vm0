"use client";

import dynamic from "next/dynamic";

// ssr: false isolates the root layout from any server-render error inside
// Clerk's <GoogleOneTap />. A client-side render error would still surface,
// but functional components can't be error boundaries and the web app
// forbids class components, so SSR isolation is the only layer we get.
const GoogleOneTap = dynamic(
  () => {
    return import("@clerk/nextjs").then((mod) => {
      return mod.GoogleOneTap;
    });
  },
  { ssr: false },
);

interface SafeGoogleOneTapProps {
  redirectUrl: string;
}

export function SafeGoogleOneTap({ redirectUrl }: SafeGoogleOneTapProps) {
  return (
    <GoogleOneTap
      signInForceRedirectUrl={redirectUrl}
      signUpForceRedirectUrl={redirectUrl}
    />
  );
}
