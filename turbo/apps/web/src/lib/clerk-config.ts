import { env } from "../env";
import { isCommunityEdition } from "./edition";

/**
 * Get Clerk publishable key from validated environment
 * Returns empty string for Community Edition (Clerk not used)
 */
export function getClerkPublishableKey(): string {
  if (isCommunityEdition()) {
    return "";
  }

  const environment = env();
  const key = environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!key) {
    throw new Error(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required for Cloud Edition",
    );
  }

  return key;
}
