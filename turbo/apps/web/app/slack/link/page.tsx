import { redirect } from "next/navigation";
import { getPlatformUrl } from "../../../src/lib/url";

/**
 * Backward compatibility redirect: old web /slack/link URLs → platform /slack/connect
 */
export default function SlackLinkPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): never {
  const platformUrl = getPlatformUrl();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  redirect(`${platformUrl}/slack/connect${qs ? `?${qs}` : ""}`);
}
