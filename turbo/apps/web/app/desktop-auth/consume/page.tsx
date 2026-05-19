import type { Metadata } from "next";

import { DesktopAuthConsumeClient } from "./DesktopAuthConsumeClient";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

interface DesktopAuthConsumePageProps {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}

function firstSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DesktopAuthConsumePage({
  searchParams,
}: DesktopAuthConsumePageProps) {
  const params = (await searchParams) ?? {};
  const code = firstSearchParam(params.code);

  if (!code) {
    return (
      <DesktopAuthConsumeClient errorMessage="Missing desktop sign-in code." />
    );
  }

  return <DesktopAuthConsumeClient code={code} />;
}
