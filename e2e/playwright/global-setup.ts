import { clerkSetup } from "@clerk/testing/playwright";
import {
  createOrganizationMembership,
  createOrganization,
  createUser,
  deleteStaleTestUsers,
  generateTestEmail,
  runnerTestAccounts,
} from "./lib/clerk-api";

export default async function globalSetup(): Promise<void> {
  // Publishes CLERK_FAPI and CLERK_TESTING_TOKEN into the environment that
  // every Playwright worker inherits, so `setupClerkTestingToken` works in
  // each worker process. Clerk requires this during global setup: a token
  // fetched inside one test body never reaches the other workers.
  await clerkSetup();

  await deleteStaleTestUsers();

  if (process.env.E2E_RUNNER_API === "1") {
    const accounts = runnerTestAccounts();
    const runnerUserId = await createUser(accounts.runner);
    const codexUserId = await createUser(accounts.codex);
    const claudeUserId = await createUser(accounts.claude);
    const orgId = await createOrganization("Runner API E2E", runnerUserId);
    await createOrganizationMembership(orgId, codexUserId);
    await createOrganizationMembership(orgId, claudeUserId);

    console.log(
      "[globalSetup] runner accounts:",
      accounts.runner,
      accounts.codex,
      accounts.claude,
      "orgId:",
      orgId,
    );
    process.env.E2E_CLERK_USER_EMAIL = accounts.runner;
    process.env.E2E_RUNNER_EMAIL = accounts.runner;
    process.env.E2E_RUNNER_CODEX_EMAIL = accounts.codex;
    process.env.E2E_RUNNER_CLAUDE_EMAIL = accounts.claude;
    process.env.E2E_CLERK_ORG_ID = orgId;
    return;
  }

  const email = generateTestEmail();
  console.log("[globalSetup] email:", email);
  const userId = await createUser(email);
  const orgId = await createOrganization("E2E Test Org", userId);
  console.log("[globalSetup] userId:", userId, "orgId:", orgId);

  process.env.E2E_CLERK_USER_EMAIL = email;
  process.env.E2E_CLERK_ORG_ID = orgId;
}
