import { deleteClerkTestOwnerResources } from "./lib/clerk-api";

export default async function globalTeardown(): Promise<void> {
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (email) {
    console.log("Cleaning up generation-scoped Clerk resources");
    await deleteClerkTestOwnerResources(
      email,
      process.env.E2E_CLERK_ORG_ID,
      "playwright",
    );
  }
}
