import {
  createOrganization,
  createUser,
  deleteStaleTestUsers,
  generateTestEmail,
} from "./lib/clerk-api";

export default async function globalSetup(): Promise<void> {
  const email = generateTestEmail();
  console.log("[globalSetup] email:", email);

  await deleteStaleTestUsers();
  const userId = await createUser(email);
  const orgId = await createOrganization("E2E Test Org", userId);
  console.log("[globalSetup] userId:", userId, "orgId:", orgId);

  process.env.E2E_CLERK_USER_EMAIL = email;
}
