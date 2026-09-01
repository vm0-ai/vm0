import {
  createOrganization,
  createUser,
  deleteClerkTestOwnerResources,
  generateTestEmail,
} from "./lib/clerk-api";

export default async function globalSetup(): Promise<void> {
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
