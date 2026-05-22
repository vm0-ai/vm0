import {
  insertTestUserSecret,
  insertTestUserVariable,
} from "../db-test-seeders/secrets";
import { getTestAuthContext } from "./core";

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
  const { userId, orgId } = await getTestAuthContext();
  const secret = await insertTestUserSecret({
    orgId,
    userId,
    name,
    value,
    description: description ?? null,
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
 * Create or update a platform variable for the mocked authenticated user.
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
  const { userId, orgId } = await getTestAuthContext();
  const variable = await insertTestUserVariable({
    orgId,
    userId,
    name,
    value,
    description: description ?? null,
  });
  return {
    ...variable,
    createdAt: variable.createdAt.toISOString(),
    updatedAt: variable.updatedAt.toISOString(),
  };
}
