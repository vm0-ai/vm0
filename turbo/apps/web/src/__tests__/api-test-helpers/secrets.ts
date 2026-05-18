import { POST as setVariableRoute } from "../../../app/api/zero/variables/route";
import { getAuthContext } from "../../lib/auth/get-auth-context";
import { resolveOrg } from "../../lib/zero/org/resolve-org";
import { insertTestUserSecret } from "../db-test-seeders/secrets";
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
  const authCtx = await getAuthContext();
  if (!authCtx) {
    throw new Error("Failed to create secret: not authenticated");
  }
  const { org } = await resolveOrg(authCtx);
  const secret = await insertTestUserSecret({
    orgId: org.orgId,
    userId: authCtx.userId,
    name,
    value,
    description,
  });
  return {
    id: secret.id,
    name: secret.name,
    description: secret.description,
    type: secret.type,
    createdAt: secret.createdAt.toISOString(),
    updatedAt: secret.updatedAt.toISOString(),
  };
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
