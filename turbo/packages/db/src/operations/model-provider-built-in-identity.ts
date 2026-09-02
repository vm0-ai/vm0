import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { modelProviders } from "../schema/model-provider";

const ORG_NO_SECRET_PROVIDER_USER_ID = "__org__";

type ModelProviderRow = typeof modelProviders.$inferSelect;

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

    const [existingProvider] = await tx
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.userId, ORG_NO_SECRET_PROVIDER_USER_ID),
          eq(modelProviders.type, "built-in"),
        ),
      )
      .for("update");
    signal.throwIfAborted();

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
