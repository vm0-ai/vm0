import { clerkSetup } from "@clerk/testing/playwright";
import {
  createOrganization,
  createUser,
  deleteStaleTestUsers,
  generateTestEmail,
} from "./lib/clerk-api";

export default async function globalSetup(): Promise<void> {
  // Publishes CLERK_FAPI and CLERK_TESTING_TOKEN into the environment that
  // every Playwright worker inherits, so `setupClerkTestingToken` works in
  // each worker process. Clerk requires this during global setup: a token
  // fetched inside one test body never reaches the other workers.
  await clerkSetup();

  const email = generateTestEmail();
  console.log("[globalSetup] email:", email);

  await deleteStaleTestUsers();
  const userId = await createUser(email);
  const orgId = await createOrganization("E2E Test Org", userId);
  console.log("[globalSetup] userId:", userId, "orgId:", orgId);

  process.env.E2E_CLERK_USER_EMAIL = email;
  process.env.E2E_CLERK_ORG_ID = orgId;
}
