import { clerkClient } from "@clerk/nextjs/server";

const TEST_USER_EMAILS = {
  serial: "e2e+clerk_test@vm0.ai",
  runner: "e2e_02+clerk_test@vm0.ai",
} as const;

type TestVariant = keyof typeof TEST_USER_EMAILS;

export function isTestVariant(value: string): value is TestVariant {
  return value in TEST_USER_EMAILS;
}

/**
 * Resolve the test user ID by querying Clerk Backend API for the e2e test user.
 *
 * @param variant - which test user to resolve ("serial" or "runner")
 */
export async function resolveTestUserId(
  variant: TestVariant = "serial",
): Promise<string | null> {
  const email = TEST_USER_EMAILS[variant];
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: [email],
  });
  return users[0]?.id ?? null;
}
