import type { Metadata } from "next";

import { DesktopAuthCallbackClient } from "./DesktopAuthCallbackClient";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function DesktopAuthCallbackPage() {
  return <DesktopAuthCallbackClient />;
}
