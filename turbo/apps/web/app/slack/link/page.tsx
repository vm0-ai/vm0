import { redirect } from "next/navigation";
import { getPlatformUrl } from "../../../src/lib/url";

/**
 * Backward compatibility redirect: old web /slack/link URLs → platform /slack/connect
 */
export default async function SlackLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const platformUrl = getPlatformUrl();
  const params = new URLSearchParams();
  const resolvedParams = await searchParams;
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (typeof value === "string") {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  redirect(`${platformUrl}/slack/connect${qs ? `?${qs}` : ""}`);
}
