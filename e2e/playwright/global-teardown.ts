import { readFile } from "node:fs/promises";
import path from "node:path";
import { deleteUserByEmail } from "./lib/clerk-api";

const CREDENTIALS_PATH = path.join(
  __dirname,
  ".clerk",
  "credentials.json"
);

export default async function globalTeardown(): Promise<void> {
  const raw = await readFile(CREDENTIALS_PATH, "utf-8");
  const { email } = JSON.parse(raw) as { email: string; password: string };
  await deleteUserByEmail(email);
}
