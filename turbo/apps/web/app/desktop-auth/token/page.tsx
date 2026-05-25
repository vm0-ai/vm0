import type { Metadata } from "next";

import { DesktopAuthTokenClient } from "./DesktopAuthTokenClient";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function DesktopAuthTokenPage() {
  return <DesktopAuthTokenClient />;
}
