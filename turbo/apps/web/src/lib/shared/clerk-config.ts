import { env } from "../../env";

/**
 * Get Clerk publishable key from validated environment variables
 */
export function getClerkPublishableKey(): string {
  const environment = env();
  return environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
}

// Publishable key shape: pk_<test|live>_<base64(host$)>. Decoding lets us
// emit a <link rel="preconnect"> to the Frontend API host before clerk-js
// boots, saving the DNS+TCP+TLS round trips on first auth request.
export function getClerkFrontendApiHost(): string | null {
  const [, encoded] =
    /^pk_(?:test|live)_(.+)$/.exec(getClerkPublishableKey()) ?? [];
  if (!encoded) return null;
  const host = Buffer.from(encoded, "base64")
    .toString("utf8")
    .replace(/\$+$/, "");
  return /^[a-z0-9.-]+$/i.test(host) ? host : null;
}
