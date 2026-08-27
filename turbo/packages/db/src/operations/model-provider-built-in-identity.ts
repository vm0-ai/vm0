import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { modelProviders } from "../schema/model-provider";

const BUILT_IN_PROVIDER_IDENTITY_TYPES = ["vm0", "built-in"] as const;
const ORG_NO_SECRET_PROVIDER_USER_ID = "__org__";

type ModelProviderRow = typeof modelProviders.$inferSelect;

/**
 * #29910 DB/API rollout compatibility for a pre-1014 provider identity.
 * Remove the alias lookup only in #28368 after production acceptance, seven
 * days of zero legacy writes, and rollback plus supported-client drain.
 */
export async function upsertBuiltInNoSecretModelProviderIdentity(
  db: NodePgDatabase<Record<string, never>>,
  args: {
    readonly orgId: string;
    readonly selectedModel: string | null;
    readonly updatedAt: Date;
    readonly proposedId?: string;
  },
  signal: AbortSignal,
): Promise<{ readonly provider: ModelProviderRow; readonly created: boolean }> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('model_provider_state:' || ${args.orgId} || ':__org__:built-in'))`,
    );
    signal.throwIfAborted();

    const existingProviders = await tx
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, ORG_NO_SECRET_PROVIDER_USER_ID),
          inArray(modelProviders.type, [...BUILT_IN_PROVIDER_IDENTITY_TYPES]),
        ),
      )
      .for("update");
    signal.throwIfAborted();

    if (existingProviders.length > 1) {
      throw new Error(
        "Conflicting built-in model provider alias rows; refusing to merge or delete either row",
      );
    }

    const existingProvider = existingProviders[0];
    if (existingProvider) {
      const [provider] = await tx
        .update(modelProviders)
        .set({
          type: "built-in",
          selectedModel: args.selectedModel,
          updatedAt: args.updatedAt,
        })
        .where(eq(modelProviders.id, existingProvider.id))
        .returning();
      signal.throwIfAborted();
      if (!provider) {
        throw new Error(
          "Expected no-secret model provider update to return row",
        );
      }
      return { provider, created: false };
    }

    const proposedId = args.proposedId ?? randomUUID();
    const [provider] = await tx
      .insert(modelProviders)
      .values({
        id: proposedId,
        type: "built-in",
        userId: ORG_NO_SECRET_PROVIDER_USER_ID,
        isDefault: false,
        selectedModel: args.selectedModel,
        orgId: args.orgId,
      })
      .onConflictDoUpdate({
        target: [
          modelProviders.orgId,
          modelProviders.userId,
          modelProviders.type,
        ],
        set: {
          selectedModel: args.selectedModel,
          updatedAt: args.updatedAt,
        },
      })
      .returning();
    signal.throwIfAborted();
    if (!provider) {
      throw new Error("Expected no-secret model provider insert to return row");
    }
    return { provider, created: provider.id === proposedId };
  });
}
