import { clerkSetup } from "@clerk/testing/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createUser,
  deleteStaleTestUsers,
  generatePassword,
  generateTestEmail,
} from "./lib/clerk-api";

const CREDENTIALS_PATH = path.join(
  __dirname,
  ".clerk",
  "credentials.json"
);

export default async function globalSetup(): Promise<void> {
  await clerkSetup();

  const email = generateTestEmail();
  const password = generatePassword();

  await deleteStaleTestUsers();
  await createUser(email, password);

  await mkdir(path.dirname(CREDENTIALS_PATH), { recursive: true });
  await writeFile(
    CREDENTIALS_PATH,
    JSON.stringify({ email, password }, null, 2)
  );
}
