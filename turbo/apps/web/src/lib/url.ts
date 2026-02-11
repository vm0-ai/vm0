import { env } from "../env";

/**
 * Returns the Platform URL from the PLATFORM_URL environment variable.
 */
export function getPlatformUrl(): string {
  return env().NEXT_PUBLIC_PLATFORM_URL;
}
