import { clerkClient } from "@clerk/nextjs/server";
import { isSelfHosted } from "../../env";
import { SELF_HOSTED_USER_ID } from "./constants";

/**
 * Resolve the test user ID based on the deployment mode.
 *
 * - Self-hosted: uses the well-known default user ID (no external service needed)
 * - SaaS: queries Clerk Backend API for the e2e test user
 */
export async function resolveTestUserId(): Promise<string | null> {
  if (isSelfHosted()) {
    return SELF_HOSTED_USER_ID;
  }

  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: ["e2e+clerk_test@vm0.ai"],
  });
  return users[0]?.id ?? null;
}
