import { clerkClient } from "@clerk/nextjs/server";
import { env } from "../../env";
import { SELF_HOSTED_USER_ID } from "./constants";

const DEFAULT_TEST_EMAIL = "e2e+clerk_test@vm0.ai";

const TEST_USER_EMAILS: Record<string, string> = {
  serial: DEFAULT_TEST_EMAIL,
  parallel: "e2e_01+clerk_test@vm0.ai",
  runner: "e2e_02+clerk_test@vm0.ai",
};

/**
 * Resolve the test user ID based on the deployment mode.
 *
 * - Self-hosted: uses the well-known default user ID (no external service needed)
 * - SaaS: queries Clerk Backend API for the e2e test user
 *
 * @param variant - which test user to resolve ("serial", "parallel", or "runner")
 */
export async function resolveTestUserId(
  variant: string = "serial",
): Promise<string | null> {
  const useLocalAuth = !env().NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (useLocalAuth) {
    return SELF_HOSTED_USER_ID;
  }

  const email = TEST_USER_EMAILS[variant] ?? DEFAULT_TEST_EMAIL;
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: [email],
  });
  return users[0]?.id ?? null;
}
