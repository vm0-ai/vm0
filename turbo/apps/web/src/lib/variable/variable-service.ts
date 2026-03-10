import { eq, and } from "drizzle-orm";
import { variables } from "../../db/schema/variable";
import { badRequest, notFound } from "../errors";
import { logger } from "../logger";

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
 * List all variables for a scope (includes values)
 */
export async function listVariables(
  scopeId: string,
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
    .where(and(eq(variables.scopeId, scopeId), eq(variables.userId, userId)))
    .orderBy(variables.name);

  return result;
}

/**
 * Get a variable by name for a scope (includes value)
 */
export async function getVariable(
  scopeId: string,
  userId: string,
  name: string,
): Promise<VariableInfo | null> {
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
    .where(
      and(
        eq(variables.scopeId, scopeId),
        eq(variables.userId, userId),
        eq(variables.name, name),
      ),
    )
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
  userId: string,
): Promise<Record<string, string>> {
  const result = await globalThis.services.db
    .select({
      name: variables.name,
      value: variables.value,
    })
    .from(variables)
    .where(and(eq(variables.scopeId, scopeId), eq(variables.userId, userId)));

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
  scopeId: string,
  userId: string,
  name: string,
  value: string,
  clerkOrgId: string,
  description?: string,
): Promise<VariableInfo> {
  validateVariableName(name);

  log.debug("setting variable", { scopeId, name });

  // Check if variable exists
  const existing = await globalThis.services.db
    .select({ id: variables.id })
    .from(variables)
    .where(
      and(
        eq(variables.scopeId, scopeId),
        eq(variables.userId, userId),
        eq(variables.name, name),
      ),
    )
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
      scopeId,
      name,
      value,
      description: description ?? null,
      userId,
      clerkOrgId,
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
  scopeId: string,
  userId: string,
  name: string,
): Promise<void> {
  // Check if this variable exists
  const [variable] = await globalThis.services.db
    .select({ id: variables.id })
    .from(variables)
    .where(
      and(
        eq(variables.scopeId, scopeId),
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

  log.debug("variable deleted", { scopeId, name });
}
