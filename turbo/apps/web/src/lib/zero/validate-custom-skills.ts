import { connectorTypeSchema } from "@vm0/core/contracts/connectors";
import { eq, and, inArray } from "drizzle-orm";
import { zeroSkills } from "../../db/schema/zero-skill";

type ValidationSuccess = { valid: true };
type ValidationFailure = {
  valid: false;
  error: {
    status: 400;
    body: { error: { message: string; code: string } };
  };
};
type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Validate that custom skill names are valid for an org:
 * 1. Not a built-in connector type name
 * 2. Exists in the org's zero_skills table
 */
export async function validateCustomSkills(
  customSkills: string[],
  orgId: string,
): Promise<ValidationResult> {
  if (customSkills.length === 0) return { valid: true };

  // Check connector name collision
  for (const name of customSkills) {
    if (connectorTypeSchema.safeParse(name).success) {
      return {
        valid: false,
        error: {
          status: 400 as const,
          body: {
            error: {
              message: `'${name}' is a built-in connector, not a custom skill. Enable it via connectors instead.`,
              code: "VALIDATION_ERROR",
            },
          },
        },
      };
    }
  }

  // Check existence in zero_skills table
  const existing = await globalThis.services.db
    .select({ name: zeroSkills.name })
    .from(zeroSkills)
    .where(
      and(eq(zeroSkills.orgId, orgId), inArray(zeroSkills.name, customSkills)),
    );

  const existingNames = new Set(
    existing.map((s) => {
      return s.name;
    }),
  );
  const missing = customSkills.filter((s) => {
    return !existingNames.has(s);
  });

  if (missing.length > 0) {
    return {
      valid: false,
      error: {
        status: 400 as const,
        body: {
          error: {
            message: `Custom skill '${missing[0]}' not found in this organization. Create it with 'zero skill create' first.`,
            code: "VALIDATION_ERROR",
          },
        },
      },
    };
  }

  return { valid: true };
}
