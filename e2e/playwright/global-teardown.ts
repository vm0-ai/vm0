import { deleteOrganizationById, deleteUserByEmail } from "./lib/clerk-api";

export default async function globalTeardown(): Promise<void> {
  const organizationId = process.env.E2E_CLERK_ORG_ID;
  if (organizationId) {
    console.log("Cleaning up test organization:", organizationId);
    await deleteOrganizationById(organizationId);
  }

  const emails = new Set(
    [
      process.env.E2E_CLERK_USER_EMAIL,
      process.env.E2E_RUNNER_EMAIL,
      process.env.E2E_RUNNER_CODEX_EMAIL,
      process.env.E2E_RUNNER_CLAUDE_EMAIL,
    ].filter((email): email is string => Boolean(email)),
  );
  for (const email of emails) {
    console.log("Cleaning up test user:", email);
    await deleteUserByEmail(email);
  }
}
