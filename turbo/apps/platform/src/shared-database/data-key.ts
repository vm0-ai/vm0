import {
  chatThreadEventSchema,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { z } from "zod";

export const sharedDatabaseIdentitySchema = z
  .object({
    userId: z.string().min(1),
    orgId: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

export type SharedDatabaseIdentity = z.infer<
  typeof sharedDatabaseIdentitySchema
>;

export const chatEventDataKeySchema = z
  .object({
    kind: z.literal("chat-event"),
    userId: z.string().min(1),
    orgId: z.string().min(1),
    threadId: z.string().min(1),
  })
  .strict();

export const chatThreadEventDataKeySchema = z
  .object({
    kind: z.literal("chat-thread-event"),
    userId: z.string().min(1),
    orgId: z.string().min(1),
  })
  .strict();

export const sharedDatabaseDataKeySchema = z.discriminatedUnion("kind", [
  chatEventDataKeySchema,
  chatThreadEventDataKeySchema,
]);

export type ChatEventDataKey = z.infer<typeof chatEventDataKeySchema>;
export type ChatThreadEventDataKey = z.infer<
  typeof chatThreadEventDataKeySchema
>;
export type SharedDatabaseDataKey = z.infer<typeof sharedDatabaseDataKeySchema>;

const sharedDatabaseConsistencySchema = z.enum(["cache-only", "catch-up"]);

export type SharedDatabaseConsistency = z.infer<
  typeof sharedDatabaseConsistencySchema
>;

export const sharedDatabaseQuerySchema = z
  .object({
    dataKey: sharedDatabaseDataKeySchema,
    afterSeqId: z.number().int().nonnegative().nullable(),
    consistency: sharedDatabaseConsistencySchema,
  })
  .strict();

export interface SharedDatabaseQuery<TKey extends SharedDatabaseDataKey> {
  readonly dataKey: TKey;
  readonly afterSeqId: number | null;
  readonly consistency: SharedDatabaseConsistency;
}

const chatThreadSnapshotSchema = chatThreadsContract.snapshot.responses[200];

export const chatThreadEventQueryResultSchema = z
  .object({
    snapshot: chatThreadSnapshotSchema.nullable(),
    events: z.array(chatThreadEventSchema),
  })
  .strict();

export type ChatThreadEventQueryResult = z.infer<
  typeof chatThreadEventQueryResultSchema
>;

interface SharedDatabaseDatasetMap {
  readonly "chat-event": {
    readonly dataKey: ChatEventDataKey;
    readonly result: ChatEventRow[];
  };
  readonly "chat-thread-event": {
    readonly dataKey: ChatThreadEventDataKey;
    readonly result: ChatThreadEventQueryResult;
  };
}

export type SharedDatabaseQueryResult<TKey extends SharedDatabaseDataKey> =
  SharedDatabaseDatasetMap[TKey["kind"]]["result"];

export function parseSharedDatabaseQueryResult<
  TKey extends SharedDatabaseDataKey,
>(dataKey: TKey, value: unknown): SharedDatabaseQueryResult<TKey> {
  if (dataKey.kind === "chat-event") {
    return chatEventRowSchema
      .array()
      .parse(value) as SharedDatabaseQueryResult<TKey>;
  }
  return chatThreadEventQueryResultSchema.parse(
    value,
  ) as SharedDatabaseQueryResult<TKey>;
}

export function sharedDatabaseDataKeyId(
  dataKey: SharedDatabaseDataKey,
): string {
  if (dataKey.kind === "chat-event") {
    return JSON.stringify([
      dataKey.kind,
      dataKey.userId,
      dataKey.orgId,
      dataKey.threadId,
    ]);
  }
  return JSON.stringify([dataKey.kind, dataKey.userId, dataKey.orgId]);
}

export function sharedDatabaseCredentialId({
  userId,
  orgId,
}: Pick<SharedDatabaseIdentity, "userId" | "orgId">): string {
  return JSON.stringify([userId, orgId]);
}
