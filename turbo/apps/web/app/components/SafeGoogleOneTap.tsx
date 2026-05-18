"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import dynamic from "next/dynamic";

// ssr: false isolates the root layout from any server-render error inside
// Clerk's <GoogleOneTap />; the boundary below isolates it from client errors.
const GoogleOneTap = dynamic(
  () => import("@clerk/nextjs").then((mod) => mod.GoogleOneTap),
  { ssr: false },
);

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  hasError: boolean;
}

class GoogleOneTapBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      "GoogleOneTap crashed; suppressed to keep marketing layout intact",
      error,
      info,
    );
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

interface SafeGoogleOneTapProps {
  redirectUrl: string;
}

export function SafeGoogleOneTap({ redirectUrl }: SafeGoogleOneTapProps) {
  return (
    <GoogleOneTapBoundary>
      <GoogleOneTap
        signInForceRedirectUrl={redirectUrl}
        signUpForceRedirectUrl={redirectUrl}
      />
    </GoogleOneTapBoundary>
  );
}
