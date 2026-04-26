import { eq, and } from "drizzle-orm";
import { variables } from "@vm0/db/schema/variable";
import { badRequest, notFound } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";

const log = logger("service:variable");

/**
 * Variable name validation regex
 * Rules:
 * - 1-255 characters
 * - uppercase letters, numbers, and underscores only
 * - must start with a letter
 */
const NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validate variable name format
 */
function validateVariableName(name: string): void {
  if (name.length === 0 || name.length > 255) {
    throw badRequest("Variable name must be between 1 and 255 characters");
  }

  if (!NAME_REGEX.test(name)) {
    throw badRequest(
      "Variable name must contain only uppercase letters, numbers, and underscores, and must start with a letter (e.g., MY_VAR)",
    );
  }
}

interface VariableInfo {
  id: string;
  name: string;
  value: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * List all variables for an org (includes values)
 */
export async function listVariables(
  orgId: string,
  userId: string,
): Promise<VariableInfo[]> {
  const result = await globalThis.services.db
    .select({
      id: variables.id,
      name: variables.name,
      value: variables.value,
      description: variables.description,
      createdAt: variables.createdAt,
      updatedAt: variables.updatedAt,
    })
    .from(variables)
    .where(and(eq(variables.orgId, orgId), eq(variables.userId, userId)))
    .orderBy(variables.name);

  return result;
}

/**
 * Get all variable values for an org as a map
 * Used for batch variable resolution during agent execution
 */
export async function getVariableValues(
  orgId: string,
  userId: string,
): Promise<Record<string, string>> {
  const result = await globalThis.services.db
    .select({
      name: variables.name,
      value: variables.value,
    })
    .from(variables)
    .where(and(eq(variables.orgId, orgId), eq(variables.userId, userId)));

  const values: Record<string, string> = {};
  for (const row of result) {
    values[row.name] = row.value;
  }

  return values;
}

/**
 * Create or update a variable (upsert)
 */
export async function setVariable(
  orgId: string,
  userId: string,
  name: string,
  value: string,
  description?: string,
): Promise<VariableInfo> {
  validateVariableName(name);

  log.debug("setting variable", { orgId, name });

  const [result] = await globalThis.services.db
    .insert(variables)
    .values({
      name,
      value,
      description: description ?? null,
      userId,
      orgId,
    })
    .onConflictDoUpdate({
      target: [variables.orgId, variables.userId, variables.name],
      set: {
        value,
        description: description ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: variables.id,
      name: variables.name,
      value: variables.value,
      description: variables.description,
      createdAt: variables.createdAt,
      updatedAt: variables.updatedAt,
    });

  if (!result) {
    throw new Error("Expected upsert to return a row");
  }

  log.debug("variable upserted", { variableId: result.id, name });
  return result;
}

/**
 * Delete a variable by name
 */
export async function deleteVariable(
  orgId: string,
  userId: string,
  name: string,
): Promise<void> {
  // Check if this variable exists
  const [variable] = await globalThis.services.db
    .select({ id: variables.id })
    .from(variables)
    .where(
      and(
        eq(variables.orgId, orgId),
        eq(variables.userId, userId),
        eq(variables.name, name),
      ),
    )
    .limit(1);

  if (!variable) {
    throw notFound(`Variable "${name}" not found`);
  }

  await globalThis.services.db
    .delete(variables)
    .where(eq(variables.id, variable.id));

  log.debug("variable deleted", { orgId, name });
}

// ============================================================================
// Org-Level Variable Functions
//
// These delegate to the user-level functions using ORG_SENTINEL_USER_ID.
// The sentinel userId ensures org and user variables are fully isolated.
// ============================================================================

/**
 * List all org-level variables (includes values)
 */
export function listOrgVariables(orgId: string): Promise<VariableInfo[]> {
  return listVariables(orgId, ORG_SENTINEL_USER_ID);
}

/**
 * Create or update an org-level variable
 */
export function setOrgVariable(
  orgId: string,
  name: string,
  value: string,
  description?: string,
): Promise<VariableInfo> {
  return setVariable(orgId, ORG_SENTINEL_USER_ID, name, value, description);
}

/**
 * Delete an org-level variable by name
 */
export function deleteOrgVariable(orgId: string, name: string): Promise<void> {
  return deleteVariable(orgId, ORG_SENTINEL_USER_ID, name);
}
