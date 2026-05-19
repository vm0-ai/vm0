import type { Metadata } from "next";
import { DesktopAuthStartClient } from "../DesktopAuthStartClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function DesktopAuthStartPage() {
  return <DesktopAuthStartClient />;
}
