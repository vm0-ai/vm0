import { secrets } from "../../db/schema/secret";
import { variables } from "../../db/schema/variable";
import { ORG_SENTINEL_USER_ID } from "../../lib/zero/org/org-sentinel";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import { POST as setSecretRoute } from "../../../app/api/zero/secrets/route";
import { POST as setVariableRoute } from "../../../app/api/zero/variables/route";
import { createTestRequest } from "./core";

// ============================================================================
// Secret Test Helpers
// ============================================================================

/**
 * Create or update a platform secret via API route handler.
 *
 * @param name - The secret name (uppercase with underscores)
 * @param value - The secret value
 * @param description - Optional description
 * @returns The created/updated secret info
 */
export async function createTestSecret(
  name: string,
  value: string,
  description?: string,
): Promise<{
  id: string;
  name: string;
  description: string | null;
  type: string;
  createdAt: string;
  updatedAt: string;
}> {
  const request = createTestRequest("http://localhost:3000/api/zero/secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value, description }),
  });
  const response = await setSecretRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create secret: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

// ============================================================================
// Variable Test Helpers
// ============================================================================

/**
 * Create or update a platform variable via API route handler.
 *
 * @param name - The variable name (uppercase with underscores)
 * @param value - The variable value
 * @param description - Optional description
 * @returns The created/updated variable info
 */
export async function createTestVariable(
  name: string,
  value: string,
  description?: string,
): Promise<{
  id: string;
  name: string;
  value: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}> {
  const request = createTestRequest(
    "http://localhost:3000/api/zero/variables",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value, description }),
    },
  );
  const response = await setVariableRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create variable: ${error.error?.message || response.status}`,
    );
  }
  return response.json();
}

export async function insertTestOrgSentinelSecret(params: {
  orgId: string;
  name: string;
}): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const encrypted = encryptSecretValue(
    "sentinel-test-value",
    SECRETS_ENCRYPTION_KEY,
  );
  await globalThis.services.db.insert(secrets).values({
    name: params.name,
    encryptedValue: encrypted,
    type: "user",
    userId: ORG_SENTINEL_USER_ID,
    orgId: params.orgId,
  });
}

export async function insertTestOrgSentinelVariable(params: {
  orgId: string;
  name: string;
}): Promise<void> {
  await globalThis.services.db.insert(variables).values({
    name: params.name,
    value: "sentinel-test-value",
    userId: ORG_SENTINEL_USER_ID,
    orgId: params.orgId,
  });
}
