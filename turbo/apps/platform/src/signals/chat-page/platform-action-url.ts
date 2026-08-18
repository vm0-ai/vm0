import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";

export function parseTrustedPlatformActionUrl(value: string): URL | null {
  return parseTrustedPlatformUrl(value);
}
