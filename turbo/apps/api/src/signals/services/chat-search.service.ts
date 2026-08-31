import { computed, type Computed } from "ccstate";
import type {
  ChatSearchMessage,
  ChatSearchResult,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "@okouai/db/schema/agent";
import { chatEventSearchMessages } from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";

import {
  chatSearchBigramTsquery,
  chatSearchMatchRanges,
} from "../../lib/chat-search-bigram";
import { pgTextDecoder } from "../../lib/db-structured-result";
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

interface ChatSearchCandidateCursor {
  readonly createdAt: string;
  readonly chatThreadId: string;
  readonly seqId: number;
}

type ChatSearchCandidateRow = ChatSearchMessageRow & {
  readonly cursorCreatedAt: string;
  readonly existingChatThreadId: string | null;
  readonly agentName: string | null;
};

const searchMessageColumns = {
  chatThreadId: chatEventSearchMessages.chatThreadId,
  seqId: chatEventSearchMessages.seqId,
  runId: chatEventSearchMessages.runId,
  role: chatEventSearchMessages.role,
  createdAt: chatEventSearchMessages.createdAt,
  text: chatEventSearchMessages.text,
} as const;

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

function chatSearchCursorCondition(
  cursor: ChatSearchCandidateCursor | undefined,
) {
  if (cursor === undefined) {
    return undefined;
  }
  const cursorCreatedAt = sql`${cursor.createdAt}::timestamp`;
  return or(
    lt(chatEventSearchMessages.createdAt, cursorCreatedAt),
    and(
      eq(chatEventSearchMessages.createdAt, cursorCreatedAt),
      lt(chatEventSearchMessages.chatThreadId, cursor.chatThreadId),
    ),
    and(
      eq(chatEventSearchMessages.createdAt, cursorCreatedAt),
      eq(chatEventSearchMessages.chatThreadId, cursor.chatThreadId),
      lt(chatEventSearchMessages.seqId, cursor.seqId),
    ),
  );
}

/**
 * Selects one bounded candidate page entirely from the durable projection.
 * Parent existence and the agent's current name are resolved only after the
 * full-text LIMIT, so the parent lookup cannot expand the expensive match.
 */
async function chatSearchIndexedMatchBatch(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly keyword: string;
    readonly agentId?: string;
    readonly since?: Date;
    readonly limit: number;
    readonly cursor?: ChatSearchCandidateCursor;
  },
): Promise<ChatSearchCandidateRow[]> {
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
        chatSearchCursorCondition(args.cursor),
      ),
    )
    // Keep the created_at prefix aligned with the scoped index while the
    // remaining columns provide a stable keyset order for equal timestamps.
    .orderBy(
      sql`${desc(chatEventSearchMessages.createdAt)} NULLS LAST`,
      desc(chatEventSearchMessages.chatThreadId),
      desc(chatEventSearchMessages.seqId),
    )
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
      cursorCreatedAt: sql`${indexedMatches.createdAt}::text`
        .mapWith(pgTextDecoder)
        .as("cursor_created_at"),
      existingChatThreadId: chatThreads.id,
      agentName: agents.name,
    })
    .from(indexedMatches)
    .leftJoin(chatThreads, eq(indexedMatches.chatThreadId, chatThreads.id))
    .leftJoin(agents, eq(indexedMatches.agentId, agents.id))
    .orderBy(
      desc(indexedMatches.createdAt),
      desc(indexedMatches.chatThreadId),
      desc(indexedMatches.seqId),
    );
}

/**
 * Over-fetches bounded candidate pages and discards rows whose source thread
 * has already been deleted. A stable keyset cursor continues past orphan-heavy
 * pages until the caller's result probe is full or the index is exhausted.
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
  const candidateLimit = args.limit * 2;
  const matches: ChatSearchMatchRow[] = [];
  let cursor: ChatSearchCandidateCursor | undefined;

  while (matches.length < args.limit) {
    const candidates = await chatSearchIndexedMatchBatch(db, {
      ...args,
      limit: candidateLimit,
      cursor,
    });
    if (candidates.length === 0) {
      break;
    }

    for (const candidate of candidates) {
      if (
        candidate.existingChatThreadId === null ||
        candidate.agentName === null
      ) {
        continue;
      }
      matches.push({
        chatThreadId: candidate.chatThreadId,
        seqId: candidate.seqId,
        runId: candidate.runId,
        role: candidate.role,
        createdAt: candidate.createdAt,
        text: candidate.text,
        agentName: candidate.agentName,
      });
      if (matches.length === args.limit) {
        break;
      }
    }

    if (matches.length === args.limit || candidates.length < candidateLimit) {
      break;
    }
    const lastCandidate = candidates[candidates.length - 1];
    if (!lastCandidate) {
      throw new Error("Chat search candidate page unexpectedly has no tail");
    }
    cursor = {
      createdAt: lastCandidate.cursorCreatedAt,
      chatThreadId: lastCandidate.chatThreadId,
      seqId: lastCandidate.seqId,
    };
  }

  return matches;
}

export function chatSearch(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly keyword: string;
  readonly agentId?: string;
  readonly since?: number;
  readonly limit: number;
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
    const results = truncated.map((match): ChatSearchResult => {
      const matchedMessage = toChatSearchMessage(match);
      return {
        chatThreadId: match.chatThreadId,
        agentName: match.agentName,
        matchedMessage,
        matchedRanges: chatSearchMatchRanges(
          matchedMessage.content,
          args.keyword,
        ),
        // #30468 removes these response-only fields after old web/app builds
        // and commit-addressed CLI execution contexts have drained.
        contextBefore: [],
        contextAfter: [],
      };
    });

    return { results, hasMore };
  });
}
