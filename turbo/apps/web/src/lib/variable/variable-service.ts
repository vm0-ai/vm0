import { eq, and } from "drizzle-orm";
import { variables } from "../../db/schema/variable";
import { badRequest, notFound } from "../errors";
import { logger } from "../logger";
import { getUserScopeByClerkId } from "../scope/scope-service";

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
 * List all variables for a user's scope (includes values)
 */
export async function listVariables(
  clerkUserId: string,
): Promise<VariableInfo[]> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return [];
  }

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
    .where(eq(variables.scopeId, scope.id))
    .orderBy(variables.name);

  return result;
}

/**
 * Get a variable by name for a user's scope (includes value)
 */
export async function getVariable(
  clerkUserId: string,
  name: string,
): Promise<VariableInfo | null> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    return null;
  }

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
    .where(and(eq(variables.scopeId, scope.id), eq(variables.name, name)))
    .limit(1);

  if (!result[0]) {
    return null;
  }

  return result[0];
}

/**
 * Get all variable values for a scope as a map
 * Used for batch variable resolution during agent execution
 */
export async function getVariableValues(
  scopeId: string,
): Promise<Record<string, string>> {
  const result = await globalThis.services.db
    .select({
      name: variables.name,
      value: variables.value,
    })
    .from(variables)
    .where(eq(variables.scopeId, scopeId));

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
  clerkUserId: string,
  name: string,
  value: string,
  description?: string,
): Promise<VariableInfo> {
  validateVariableName(name);

  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw badRequest(
      "You need to configure a scope first. Run `vm0 scope create` to set up your scope.",
    );
  }

  log.debug("setting variable", { scopeId: scope.id, name });

  // Check if variable exists
  const existing = await globalThis.services.db
    .select({ id: variables.id })
    .from(variables)
    .where(and(eq(variables.scopeId, scope.id), eq(variables.name, name)))
    .limit(1);

  if (existing[0]) {
    // Update existing variable
    const [updated] = await globalThis.services.db
      .update(variables)
      .set({
        value,
        description: description ?? null,
        updatedAt: new Date(),
      })
      .where(eq(variables.id, existing[0].id))
      .returning({
        id: variables.id,
        name: variables.name,
        value: variables.value,
        description: variables.description,
        createdAt: variables.createdAt,
        updatedAt: variables.updatedAt,
      });

    log.debug("variable updated", { variableId: updated!.id, name });
    return updated!;
  }

  // Create new variable
  const [created] = await globalThis.services.db
    .insert(variables)
    .values({
      scopeId: scope.id,
      name,
      value,
      description: description ?? null,
    })
    .returning({
      id: variables.id,
      name: variables.name,
      value: variables.value,
      description: variables.description,
      createdAt: variables.createdAt,
      updatedAt: variables.updatedAt,
    });

  log.debug("variable created", { variableId: created!.id, name });
  return created!;
}

/**
 * Delete a variable by name
 */
export async function deleteVariable(
  clerkUserId: string,
  name: string,
): Promise<void> {
  const scope = await getUserScopeByClerkId(clerkUserId);
  if (!scope) {
    throw notFound("Variable not found");
  }

  // Check if this variable exists
  const [variable] = await globalThis.services.db
    .select({ id: variables.id })
    .from(variables)
    .where(and(eq(variables.scopeId, scope.id), eq(variables.name, name)))
    .limit(1);

  if (!variable) {
    throw notFound(`Variable "${name}" not found`);
  }

  await globalThis.services.db
    .delete(variables)
    .where(eq(variables.id, variable.id));

  log.debug("variable deleted", { scopeId: scope.id, name });
}
