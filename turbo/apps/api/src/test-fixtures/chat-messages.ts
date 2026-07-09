import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { secrets } from "@vm0/db/schema/secret";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, like, or } from "drizzle-orm";

import { db } from "../lib/db";
import { BEFORE_DISPATCH_CANCELLED_ERROR } from "../signals/services/agent-run-create.service";
import { encryptPersistentSecretValue } from "../signals/services/crypto.utils";

const ORG_SENTINEL_USER_ID = "__org__";

/**
 * BDD-scoped vm0 managed key prefixes. Fixture writes below only ever touch
 * rows whose api_key carries one of these prefixes, so concurrent test files
 * cannot clobber real seed data or each other's non-bdd rows.
 */
const VM0_BDD_API_KEY_PREFIXES = [
  "vm0-key-bdd-fake-",
  "vm0-key-bdd-dev-seed-",
] as const;

type ChatMessageInsert = typeof chatMessages.$inferInsert;

interface SeedChatThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly createdAt: Date;
  readonly sequenceNumber: number | null;
  readonly runLifecycleEvent?: NonNullable<
    ChatMessageInsert["runLifecycleEvent"]
  >;
  readonly recommendedFollowups?: NonNullable<
    ChatMessageInsert["recommendedFollowups"]
  >;
}

/**
 * Inserts chat messages with caller-chosen ids and identical created_at
 * timestamps.
 *
 * Why product APIs cannot construct this state: the cursor tie-break
 * regression under test requires several messages sharing one exact
 * created_at with ids in a known sort order. Product sends assign their own
 * ids and monotonically increasing timestamps, so the tie can never be
 * produced deterministically through the send route.
 */
export async function seedChatThreadMessages(
  threadId: string,
  messages: readonly SeedChatThreadMessage[],
): Promise<void> {
  await db()
    .insert(chatMessages)
    .values(
      messages.map((message) => {
        return {
          id: message.id,
          chatThreadId: threadId,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          sequenceNumber: message.sequenceNumber,
          runLifecycleEvent: message.runLifecycleEvent,
          recommendedFollowups: message.recommendedFollowups,
        };
      }),
    );
}

function bddVm0ApiKeyFilter(vendor: string, model: string) {
  const [fakePrefix, devSeedPrefix] = VM0_BDD_API_KEY_PREFIXES;
  return and(
    eq(vm0ApiKeys.vendor, vendor),
    eq(vm0ApiKeys.model, model),
    or(
      like(vm0ApiKeys.apiKey, `${fakePrefix}%`),
      like(vm0ApiKeys.apiKey, `${devSeedPrefix}%`),
    ),
  );
}

/**
 * Replaces the bdd-scoped rows of the platform-managed vm0 API key pool for
 * one vendor/model.
 *
 * Why product APIs cannot construct this state: vm0_api_keys is a
 * platform-operations table with no product write surface — keys are
 * provisioned out of band. Keys passed here must carry a
 * VM0_BDD_API_KEY_PREFIXES prefix so only bdd rows are touched.
 */
export async function replaceBddVm0ApiKeys(args: {
  readonly vendor: string;
  readonly model: string;
  readonly keys: readonly { readonly apiKey: string; readonly label: string }[];
}): Promise<void> {
  for (const key of args.keys) {
    const scoped = VM0_BDD_API_KEY_PREFIXES.some((prefix) => {
      return key.apiKey.length > prefix.length && key.apiKey.startsWith(prefix);
    });
    if (!scoped) {
      throw new Error(
        `replaceBddVm0ApiKeys: api key must start with one of ${VM0_BDD_API_KEY_PREFIXES.join(", ")}`,
      );
    }
  }
  await db().transaction(async (tx) => {
    await tx
      .delete(vm0ApiKeys)
      .where(bddVm0ApiKeyFilter(args.vendor, args.model));
    if (args.keys.length > 0) {
      await tx.insert(vm0ApiKeys).values(
        args.keys.map((key) => {
          return {
            vendor: args.vendor,
            model: args.model,
            apiKey: key.apiKey,
            label: key.label,
          };
        }),
      );
    }
  });
}

/**
 * Deletes the bdd-scoped rows of the platform-managed vm0 API key pool for
 * one vendor/model. See replaceBddVm0ApiKeys for why no product API exists.
 */
export async function deleteBddVm0ApiKeys(args: {
  readonly vendor: string;
  readonly model: string;
}): Promise<void> {
  await db()
    .delete(vm0ApiKeys)
    .where(bddVm0ApiKeyFilter(args.vendor, args.model));
}

/**
 * Overwrites an existing org model-provider secret with an arbitrary
 * (typically blank/corrupt) value.
 *
 * Why product APIs cannot construct this state: the provider upsert route
 * validates and rejects blank secrets by design; the legacy-blank-secret
 * rejection path under test only exists for rows written before that
 * validation shipped.
 */
export async function overwriteOrgModelProviderSecret(args: {
  readonly orgId: string;
  readonly name: string;
  readonly value: string;
}): Promise<void> {
  const encryptedValue = await encryptPersistentSecretValue(args.value, {
    orgId: args.orgId,
    userId: ORG_SENTINEL_USER_ID,
  });
  await db()
    .update(secrets)
    .set({ encryptedValue })
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, ORG_SENTINEL_USER_ID),
        eq(secrets.name, args.name),
        eq(secrets.type, "model-provider"),
      ),
    );
}

/**
 * Marks an already product-cancelled run as pre-dispatch cancelled and
 * attaches it to a chat thread.
 *
 * Why product APIs cannot construct this state: the
 * BEFORE_DISPATCH_CANCELLED_ERROR marker is only written when a cancel races
 * the dispatch transaction inside run creation, and a run created outside the
 * chat send route never carries a chat_thread_id. Tests build the run through
 * the product create + cancel routes first, then use this to shape the ghost
 * row the chat-context exclusion filter must skip.
 */
export async function attachPreDispatchCancelledRunToThread(args: {
  readonly runId: string;
  readonly threadId: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .update(agentRuns)
      .set({ error: BEFORE_DISPATCH_CANCELLED_ERROR })
      .where(
        and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "cancelled")),
      );
    await tx
      .update(zeroRuns)
      .set({ chatThreadId: args.threadId })
      .where(eq(zeroRuns.id, args.runId));
  });
}
