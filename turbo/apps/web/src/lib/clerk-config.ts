/**
 * Get Clerk publishable key from environment
 * Note: We read directly from process.env to avoid triggering full env validation during build
 */
export function getClerkPublishableKey(): string {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!key) {
    throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not defined");
  }
  return key;
}
