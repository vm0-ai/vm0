import { clerkSetup } from "@clerk/testing/playwright";
import {
  createOrganization,
  createUser,
  deleteClerkTestOwnerResources,
  generateTestEmail,
} from "./lib/clerk-api";

export default async function globalSetup(): Promise<void> {
  // Publishes CLERK_FAPI and CLERK_TESTING_TOKEN into the environment that
  // every Playwright worker inherits, so `setupClerkTestingToken` works in
  // each worker process. Clerk requires this during global setup: a token
  // fetched inside one test body never reaches the other workers.
  await clerkSetup();

  const email = generateTestEmail("playwright");
  console.log("[globalSetup] creating generation-scoped Clerk resources");
  process.env.E2E_CLERK_USER_EMAIL = email;

  let organizationId: string | undefined;
  try {
    const userId = await createUser(email);
    organizationId = await createOrganization(
      "E2E Test Org",
      userId,
      "playwright",
    );
    process.env.E2E_CLERK_ORG_ID = organizationId;
    console.log("[globalSetup] Clerk resources ready");
  } catch (cause) {
    await deleteClerkTestOwnerResources(email, organizationId, "playwright");
    throw cause;
  }
}
