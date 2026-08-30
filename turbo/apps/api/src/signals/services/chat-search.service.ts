import { computed, type Computed } from "ccstate";
import type {
  ChatSearchMessage,
  ChatSearchResult,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "@okouai/db/schema/agent";
import { chatEventSearchMessages } from "@okouai/db/schema/chat-event-search";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gt, gte, lt, type SQL, sql } from "drizzle-orm";

import {
  chatSearchBigramTsquery,
  chatSearchMatchRanges,
} from "../../lib/chat-search-bigram";
import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import { db$, type ReadonlyDb } from "../external/db";

type ChatSearchMessageRow = {
  readonly chatThreadId: string;
  readonly seqId: number;
  readonly runId: string | null;
  readonly role: "user" | "assistant";
  readonly createdAt: Date;
  readonly text: string;
};

type ChatSearchMatchRow = ChatSearchMessageRow & {
  readonly agentName: string;
};

interface ChatSearchContext {
  readonly before: ChatSearchMessage[];
  readonly after: ChatSearchMessage[];
}

const contextSearchMessage = alias(
  chatEventSearchMessages,
  "context_search_message",
);

const searchMessageColumns = {
  chatThreadId: chatEventSearchMessages.chatThreadId,
  seqId: chatEventSearchMessages.seqId,
  runId: chatEventSearchMessages.runId,
  role: chatEventSearchMessages.role,
  createdAt: chatEventSearchMessages.createdAt,
  text: chatEventSearchMessages.text,
} as const;

const contextSearchMessageColumns = {
  chatThreadId: contextSearchMessage.chatThreadId,
  seqId: contextSearchMessage.seqId,
  runId: contextSearchMessage.runId,
  role: contextSearchMessage.role,
  createdAt: contextSearchMessage.createdAt,
  text: contextSearchMessage.text,
} as const;

function chatSearchMessageKey(
  row: Pick<ChatSearchMessageRow, "chatThreadId" | "seqId">,
): string {
  return `${row.chatThreadId}:${row.seqId}`;
}

function toChatSearchMessage(row: ChatSearchMessageRow): ChatSearchMessage {
  return {
    chatThreadId: row.chatThreadId,
    role: row.role,
    content: row.text,
    createdAt: row.createdAt.toISOString(),
    seqId: row.seqId,
    runId: row.runId,
  };
}

/**
 * Selects keyword matches, ownership, agent scope, `since`, ordering and the
 * limit entirely from the durable message projection. The outer join only
 * resolves the agent's current name after the bounded match set is selected.
 */
async function chatSearchIndexedMatches(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly keyword: string;
    readonly agentId?: string;
    readonly since?: Date;
    readonly limit: number;
  },
): Promise<ChatSearchMatchRow[]> {
  const tsquery = chatSearchBigramTsquery(args.keyword);
  if (tsquery === null) {
    return [];
  }

  const indexedMatches = db
    .select({
      ...searchMessageColumns,
      agentId: chatEventSearchMessages.agentId,
    })
    .from(chatEventSearchMessages)
    .where(
      and(
        eq(chatEventSearchMessages.userId, args.userId),
        eq(chatEventSearchMessages.orgId, args.orgId),
        sql`${chatEventSearchMessages.tsv} @@ to_tsquery('simple', ${tsquery})`,
        args.agentId
          ? eq(chatEventSearchMessages.agentId, args.agentId)
          : undefined,
        args.since
          ? gte(chatEventSearchMessages.createdAt, args.since)
          : undefined,
      ),
    )
    .orderBy(desc(chatEventSearchMessages.createdAt))
    .limit(args.limit)
    .as("chat_search_indexed_matches");

  return await db
    .select({
      chatThreadId: indexedMatches.chatThreadId,
      seqId: indexedMatches.seqId,
      runId: indexedMatches.runId,
      role: indexedMatches.role,
      createdAt: indexedMatches.createdAt,
      text: indexedMatches.text,
      agentName: agents.name,
    })
    .from(indexedMatches)
    .innerJoin(agents, eq(indexedMatches.agentId, agents.id))
    .orderBy(desc(indexedMatches.createdAt));
}

function chatSearchMatchesTable(matches: readonly ChatSearchMessageRow[]): SQL {
  return sql`unnest(
      ${sql.param(
        matches.map((match) => {
          return match.chatThreadId;
        }),
      )}::uuid[],
      ${sql.param(
        matches.map((match) => {
          return match.seqId;
        }),
      )}::bigint[]
    ) WITH ORDINALITY AS chat_search_matches(
      chat_thread_id,
      seq_id,
      result_ordinality
    )`;
}

function chatSearchContextSideQuery(
  db: ReadonlyDb,
  args: {
    readonly isBefore: boolean;
    readonly limit: number;
  },
) {
  return db
    .select({
      isBefore: sql`${args.isBefore}::boolean`
        .mapWith(pgBooleanDecoder)
        .as("is_before"),
      ...contextSearchMessageColumns,
    })
    .from(contextSearchMessage)
    .where(
      and(
        eq(
          contextSearchMessage.chatThreadId,
          sql`chat_search_matches.chat_thread_id`,
        ),
        args.isBefore
          ? lt(contextSearchMessage.seqId, sql`chat_search_matches.seq_id`)
          : gt(contextSearchMessage.seqId, sql`chat_search_matches.seq_id`),
      ),
    )
    .orderBy(
      args.isBefore
        ? desc(contextSearchMessage.seqId)
        : asc(contextSearchMessage.seqId),
    )
    .limit(args.limit);
}

async function loadChatSearchContexts(
  db: ReadonlyDb,
  args: {
    readonly matches: readonly ChatSearchMessageRow[];
    readonly before: number;
    readonly after: number;
  },
): Promise<ReadonlyMap<string, ChatSearchContext>> {
  const contextsByMessageKey = new Map<string, ChatSearchContext>(
    args.matches.map((match): readonly [string, ChatSearchContext] => {
      return [chatSearchMessageKey(match), { before: [], after: [] }];
    }),
  );
  if (args.matches.length === 0 || (args.before === 0 && args.after === 0)) {
    return contextsByMessageKey;
  }

  const contextQuery =
    args.before > 0
      ? args.after > 0
        ? chatSearchContextSideQuery(db, {
            isBefore: true,
            limit: args.before,
          }).unionAll(
            chatSearchContextSideQuery(db, {
              isBefore: false,
              limit: args.after,
            }),
          )
        : chatSearchContextSideQuery(db, {
            isBefore: true,
            limit: args.before,
          })
      : chatSearchContextSideQuery(db, {
          isBefore: false,
          limit: args.after,
        });

  const context = contextQuery.as("chat_search_context");
  const resultOrdinality = sql`chat_search_matches.result_ordinality::integer`
    .mapWith(pgIntegerDecoder)
    .as("result_ordinality");
  const matchedChatThreadId = sql`chat_search_matches.chat_thread_id`
    .mapWith(chatEventSearchMessages.chatThreadId)
    .as("matched_chat_thread_id");
  const matchedSeqId = sql`chat_search_matches.seq_id`
    .mapWith(chatEventSearchMessages.seqId)
    .as("matched_seq_id");
  const rows = await db
    .select({
      resultOrdinality,
      matchedChatThreadId,
      matchedSeqId,
      isBefore: context.isBefore,
      chatThreadId: context.chatThreadId,
      seqId: context.seqId,
      runId: context.runId,
      role: context.role,
      createdAt: context.createdAt,
      text: context.text,
    })
    .from(chatSearchMatchesTable(args.matches))
    .crossJoinLateral(context)
    .orderBy(resultOrdinality, asc(context.seqId));

  for (const row of rows) {
    const matchedMessageKey = chatSearchMessageKey({
      chatThreadId: row.matchedChatThreadId,
      seqId: row.matchedSeqId,
    });
    const matchedContext = contextsByMessageKey.get(matchedMessageKey);
    if (!matchedContext) {
      throw new Error(
        "chat search context returned an unknown matched message",
      );
    }
    const message = toChatSearchMessage(row);
    if (row.isBefore) {
      matchedContext.before.push(message);
    } else {
      matchedContext.after.push(message);
    }
  }

  return contextsByMessageKey;
}

export function chatSearch(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly keyword: string;
  readonly agentId?: string;
  readonly since?: number;
  readonly limit: number;
  readonly before: number;
  readonly after: number;
}): Computed<
  Promise<{
    readonly results: readonly ChatSearchResult[];
    readonly hasMore: boolean;
  }>
> {
  return computed(async (get) => {
    const db = get(db$);
    const sinceDate = args.since ? new Date(args.since) : undefined;
    const matches = await chatSearchIndexedMatches(db, {
      userId: args.userId,
      orgId: args.orgId,
      keyword: args.keyword,
      agentId: args.agentId,
      since: sinceDate,
      limit: args.limit + 1,
    });

    const hasMore = matches.length > args.limit;
    const truncated = hasMore ? matches.slice(0, args.limit) : matches;
    const contextsByMessageKey = await loadChatSearchContexts(db, {
      matches: truncated,
      before: args.before,
      after: args.after,
    });
    const results = truncated.map((match): ChatSearchResult => {
      const messageKey = chatSearchMessageKey(match);
      const context = contextsByMessageKey.get(messageKey);
      if (!context) {
        throw new Error("chat search context is missing a matched message");
      }
      const matchedMessage = toChatSearchMessage(match);
      return {
        chatThreadId: match.chatThreadId,
        agentName: match.agentName,
        matchedMessage,
        matchedRanges: chatSearchMatchRanges(
          matchedMessage.content,
          args.keyword,
        ),
        contextBefore: context.before,
        contextAfter: context.after,
      };
    });

    return { results, hasMore };
  });
}
