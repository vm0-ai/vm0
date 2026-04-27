import type { Metadata } from "next";
import { TelegramConnectClient } from "./TelegramConnectClient";
import { parseTelegramConnectParams } from "./connect-params";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: "Connect Telegram - VM0",
  description: "Connect your Telegram account to VM0.",
};

export default async function TelegramConnectPage({ searchParams }: PageProps) {
  const parsed = parseTelegramConnectParams(await searchParams);

  return (
    <TelegramConnectClient
      params={parsed.ok ? parsed.params : null}
      paramError={parsed.ok ? null : parsed.error}
      returnPath={parsed.returnPath}
    />
  );
}
