import { deleteUserByEmail } from "./lib/clerk-api";

export default async function globalTeardown(): Promise<void> {
  const email = process.env.E2E_CLERK_USER_EMAIL;
  if (email) {
    console.log("Cleaning up test user:", email);
    await deleteUserByEmail(email);
  }
}
