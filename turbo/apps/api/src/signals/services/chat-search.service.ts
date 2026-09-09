import { computed, type Computed } from "ccstate";
import {
  CHAT_SEARCH_RESULT_LIMIT,
  type ChatSearchMessage,
  type ChatSearchResult,
} from "@okouai/api-contracts/contracts/chat-threads";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";
import { agents } from "@okouai/db/schema/agent";
import { chatEventSearchMessages } from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, count, desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";

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

const RECENT_SEARCH_CANDIDATE_MULTIPLIER = 16;

function toChatSearchMessage(row: ChatSearchMessageRow): ChatSearchMessage {
  return {
    chatThreadId: row.chatThreadId,
    role: row.role,
    content:
      row.role === "assistant"
        ? visiblePiMemoryCitationText(row.text)
        : row.text,
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

function chatSearchRecentMatches(
  db: ReadonlyDb,
  args: {
    readonly scopeCondition: SQL | undefined;
    readonly tsquery: string;
    readonly limit: number;
  },
) {
  // Common terms can fill a page from recent messages. Bound this ordered
  // scan before applying the keyword so rare terms cannot scan all history.
  const recentMessages = db
    .select({
      ...searchMessageColumns,
      agentId: chatEventSearchMessages.agentId,
      tsv: chatEventSearchMessages.tsv,
    })
    .from(chatEventSearchMessages)
    .where(args.scopeCondition)
    .orderBy(
      sql`${desc(chatEventSearchMessages.createdAt)} NULLS LAST`,
      desc(chatEventSearchMessages.chatThreadId),
      desc(chatEventSearchMessages.seqId),
    )
    .limit(args.limit * RECENT_SEARCH_CANDIDATE_MULTIPLIER)
    .as("chat_search_recent_messages");
  return db.$with("chat_search_recent_matches").as(
    db
      .select({
        chatThreadId: recentMessages.chatThreadId,
        seqId: recentMessages.seqId,
        runId: recentMessages.runId,
        role: recentMessages.role,
        createdAt: recentMessages.createdAt,
        text: recentMessages.text,
        agentId: recentMessages.agentId,
      })
      .from(recentMessages)
      .where(
        sql`${recentMessages.tsv} @@ to_tsquery('simple', ${args.tsquery})`,
      )
      .orderBy(
        sql`${desc(recentMessages.createdAt)} NULLS LAST`,
        desc(recentMessages.chatThreadId),
        desc(recentMessages.seqId),
      )
      .limit(args.limit),
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

  const scopeCondition = and(
    eq(chatEventSearchMessages.userId, args.userId),
    eq(chatEventSearchMessages.orgId, args.orgId),
    args.agentId
      ? eq(chatEventSearchMessages.agentId, args.agentId)
      : undefined,
    args.since ? gte(chatEventSearchMessages.createdAt, args.since) : undefined,
    chatSearchCursorCondition(args.cursor),
  );

  const recentMatches = chatSearchRecentMatches(db, {
    scopeCondition,
    tsquery,
    limit: args.limit,
  });
  const recentMatchCount = db.select({ count: count() }).from(recentMatches);

  const projectionColumns = {
    ...searchMessageColumns,
    agentId: chatEventSearchMessages.agentId,
  };
  const keywordQuery = db
    .select(projectionColumns)
    .from(chatEventSearchMessages)
    .where(
      and(
        scopeCondition,
        sql`${chatEventSearchMessages.tsv} @@ to_tsquery('simple', ${tsquery})`,
      ),
    );
  // OFFSET 0 keeps Top-N planning outside the complete keyword match. Unlike
  // materializing every message body, it streams matches into a bounded sort.
  // Drizzle omits a numeric .offset(0), so retain this SQL optimization fence.
  const keywordMatches = db
    .$with("chat_search_keyword_matches", projectionColumns)
    .as(sql`${keywordQuery} OFFSET 0`);
  const fullMatches = db
    .select({
      chatThreadId: keywordMatches.chatThreadId,
      seqId: keywordMatches.seqId,
      runId: keywordMatches.runId,
      role: keywordMatches.role,
      createdAt: keywordMatches.createdAt,
      text: keywordMatches.text,
      agentId: keywordMatches.agentId,
    })
    .from(keywordMatches)
    .orderBy(
      sql`${desc(keywordMatches.createdAt)} NULLS LAST`,
      desc(keywordMatches.chatThreadId),
      desc(keywordMatches.seqId),
    )
    .limit(args.limit)
    .as("chat_search_full_matches");
  const indexedMatches = db
    .select({
      chatThreadId: recentMatches.chatThreadId,
      seqId: recentMatches.seqId,
      runId: recentMatches.runId,
      role: recentMatches.role,
      createdAt: recentMatches.createdAt,
      text: recentMatches.text,
      agentId: recentMatches.agentId,
    })
    .from(recentMatches)
    .where(eq(recentMatchCount, args.limit))
    .unionAll(
      db
        .select({
          chatThreadId: fullMatches.chatThreadId,
          seqId: fullMatches.seqId,
          runId: fullMatches.runId,
          role: fullMatches.role,
          createdAt: fullMatches.createdAt,
          text: fullMatches.text,
          agentId: fullMatches.agentId,
        })
        .from(fullMatches)
        .where(lt(recentMatchCount, args.limit)),
    )
    .as("chat_search_indexed_matches");

  return await db
    .with(recentMatches, keywordMatches)
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
 * Discards matches whose source thread has already been deleted. The internal
 * keyset cursor continues past those rows until 25 visible results are found
 * or the index is exhausted; it is never exposed as search pagination.
 */
async function chatSearchIndexedMatches(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly keyword: string;
    readonly agentId?: string;
    readonly since?: Date;
  },
): Promise<ChatSearchMatchRow[]> {
  const matches: ChatSearchMatchRow[] = [];
  let cursor: ChatSearchCandidateCursor | undefined;

  while (matches.length < CHAT_SEARCH_RESULT_LIMIT) {
    const candidateLimit = CHAT_SEARCH_RESULT_LIMIT - matches.length;
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
      if (matches.length === CHAT_SEARCH_RESULT_LIMIT) {
        break;
      }
    }

    if (
      matches.length === CHAT_SEARCH_RESULT_LIMIT ||
      candidates.length < candidateLimit
    ) {
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
}): Computed<
  Promise<{
    readonly results: readonly ChatSearchResult[];
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
    });

    const results = matches.map((match): ChatSearchResult => {
      const matchedMessage = toChatSearchMessage(match);
      return {
        chatThreadId: match.chatThreadId,
        agentName: match.agentName,
        matchedMessage,
        matchedRanges: chatSearchMatchRanges(
          matchedMessage.content,
          args.keyword,
        ),
      };
    });

    return { results };
  });
}
