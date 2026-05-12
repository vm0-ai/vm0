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
  await setupModelFirstDefaultProvider(email);
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

  const response = await fetch(
    `${apiUrl}/api/cli/auth/test-token?email=${encodeURIComponent(email)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...vercelBypassHeader(),
      },
    },
  );
  const body = await response.text();
  const data = body
    ? (JSON.parse(body) as { access_token?: string; error?: unknown })
    : {};

  if (!response.ok || !data.access_token) {
    const detail = data.error
      ? JSON.stringify(data.error)
      : body || response.statusText;
    throw new Error(
      `Failed to create E2E test token (${response.status}): ${detail}`,
    );
  }
  return data.access_token;
}

async function setupModelFirstDefaultProvider(email: string): Promise<void> {
  const apiUrl = process.env.VM0_API_URL;
  if (!apiUrl) {
    throw new Error("VM0_API_URL environment variable is required");
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const token = await createTestToken(email);
  const response = await fetch(`${apiUrl}/api/zero/model-providers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...vercelBypassHeader(),
    },
    body: JSON.stringify({
      type: "anthropic-api-key",
      secret: apiKey,
      selectedModel: "claude-sonnet-4-6",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to configure E2E model provider: ${body}`);
  }
}
