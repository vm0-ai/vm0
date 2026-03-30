import { clerkClient } from "@clerk/nextjs/server";

export const DEFAULT_TEST_EMAIL = "dev+clerk_test@serial.test";

/**
 * Derive a unique, valid org slug from a test user email.
 * Handles emails like "pr-123+clerk_test@runner.test" → "test-pr-123-runner".
 *
 * Org slug rules: lowercase letters, numbers, and hyphens; 3–64 chars;
 * must start and end with alphanumeric.
 *
 * @param email - the test user's email address
 * @returns a valid org slug derived from the email
 */
export function orgSlugFromEmail(email: string): string {
  // Extract the local part before the first "@"
  const local = email.split("@")[0] ?? email;
  // Use the part before "+" (job ref) and the domain label (e.g. "runner")
  const [jobRef] = local.split("+");
  const domain = email.split("@")[1]?.split(".")[0] ?? "test";
  const raw = `test-${jobRef ?? local}-${domain}`;
  // Sanitize: keep only lowercase alphanumeric and hyphens, collapse runs
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length >= 3 ? slug : `test-${slug}`;
}

/**
 * Resolve a test user ID by email. If the user doesn't exist in Clerk,
 * creates one automatically. Used by test-token, test-approve, and
 * test-connector endpoints.
 *
 * @param email - the test user's email address
 * @returns the Clerk user ID
 */
export async function resolveTestUserId(email: string): Promise<string> {
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: [email],
  });

  if (users[0]) {
    return users[0].id;
  }

  // User doesn't exist — create on the fly
  const newUser = await clerk.users.createUser({
    emailAddress: [email],
    skipPasswordRequirement: true,
  });
  return newUser.id;
}
