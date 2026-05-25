import type { Metadata } from "next";

import { DesktopAuthSelectOrgClient } from "./DesktopAuthSelectOrgClient";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

interface DesktopAuthSelectOrgPageProps {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}

function firstSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DesktopAuthSelectOrgPage({
  searchParams,
}: DesktopAuthSelectOrgPageProps) {
  const params = (await searchParams) ?? {};
  const forceSelection = firstSearchParam(params.force) === "true";
  return <DesktopAuthSelectOrgClient forceSelection={forceSelection} />;
}
