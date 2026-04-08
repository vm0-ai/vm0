import { randomBytes, randomInt } from "node:crypto";

const CLERK_API_BASE = "https://api.clerk.com/v1";

function getClerkHeaders(): Record<string, string> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY environment variable is required");
  }
  return {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };
}

export function generateTestEmail(): string {
  const jobRef = process.env.JOB_REF ?? "local";
  const randHex = randomBytes(4).toString("hex");
  return `${jobRef}+clerk_test@${randHex}.ai`;
}

export function generatePassword(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = Array.from({ length: 16 }, () =>
    chars[randomInt(chars.length)]
  ).join("");
  return `${rand}!Aa1`;
}

export async function createUser(
  email: string,
  password: string
): Promise<string> {
  const response = await fetch(`${CLERK_API_BASE}/users`, {
    method: "POST",
    headers: getClerkHeaders(),
    body: JSON.stringify({
      email_address: [email],
      password,
    }),
  });
  const data = (await response.json()) as { id?: string; errors?: unknown[] };
  if (!response.ok || !data.id) {
    throw new Error(`Failed to create Clerk user: ${JSON.stringify(data)}`);
  }
  return data.id;
}

export async function deleteUserByEmail(email: string): Promise<void> {
  const searchResponse = await fetch(
    `${CLERK_API_BASE}/users?query=${encodeURIComponent(email)}&limit=10`,
    { headers: getClerkHeaders() }
  );
  const users = (await searchResponse.json()) as Array<{
    id: string;
    email_addresses: Array<{ email_address: string }>;
  }>;

  for (const user of users) {
    const userEmail = user.email_addresses[0]?.email_address;
    if (userEmail === email) {
      const deleteResponse = await fetch(`${CLERK_API_BASE}/users/${user.id}`, {
        method: "DELETE",
        headers: getClerkHeaders(),
      });
      if (!deleteResponse.ok) {
        throw new Error(
          `Failed to delete Clerk user ${user.id}: ${deleteResponse.status}`
        );
      }
      return;
    }
  }
}
