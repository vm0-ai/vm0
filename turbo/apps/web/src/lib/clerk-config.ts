import { env } from "../env";

/**
 * Get Clerk publishable key from validated environment
 */
export function getClerkPublishableKey(): string {
  const environment = env();
  return environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}
