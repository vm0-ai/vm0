/**
 * Returns the Platform URL from the PLATFORM_URL environment variable.
 */
export function getPlatformUrl(): string {
  return process.env.PLATFORM_URL!;
}
