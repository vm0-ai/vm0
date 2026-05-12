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
  await disableModelFirstModelProvider(email);
  console.log("[globalSetup] userId:", userId, "orgId:", orgId);

  process.env.E2E_CLERK_USER_EMAIL = email;
}

function vercelBypassHeader(): Record<string, string> {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return bypass ? { "x-vercel-protection-bypass": bypass } : {};
}

async function createTestToken(email: string): Promise<string> {
  const apiUrl = process.env.VM0_API_URL;
  if (!apiUrl) {
    throw new Error("VM0_API_URL environment variable is required");
  }

  const encodedEmail = encodeURIComponent(email);
  const response = await fetch(
    `${apiUrl}/api/cli/auth/test-token?email=${encodedEmail}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...vercelBypassHeader(),
      },
    },
  );
  const data = (await response.json()) as {
    access_token?: string;
    error?: unknown;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(`Failed to create E2E test token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function disableModelFirstModelProvider(email: string): Promise<void> {
  const apiUrl = process.env.VM0_API_URL;
  if (!apiUrl) {
    throw new Error("VM0_API_URL environment variable is required");
  }

  const token = await createTestToken(email);
  const response = await fetch(`${apiUrl}/api/zero/feature-switches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...vercelBypassHeader(),
    },
    body: JSON.stringify({
      switches: { modelFirstModelProvider: false },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to disable model-first for E2E user: ${body}`);
  }
}
