/**
 * Zero API - Chat Search Endpoint
 *
 * GET /api/zero/chat/search - Search caller's own chat messages within caller's org.
 * Authorization is enforced at the DB query level via:
 *   - chatThreads.userId = authCtx.userId   (only caller's threads)
 *   - agentComposes.orgId = resolvedOrg.orgId (only caller's org)
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
} from "drizzle-orm";
import { z } from "zod";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { chatSearchContract, type ChatSearchMessage } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { chatMessages } from "../../../../../src/db/schema/chat-message";
import { chatThreads } from "../../../../../src/db/schema/chat-thread";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";

/**
 * Escape `%`, `_`, and `\` so the user-supplied keyword cannot act as a
 * LIKE/ILIKE wildcard. Drizzle parameterizes values but does not escape
 * pattern meta-characters.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * A chat message row as returned by the search and context queries.
 * `content` arrives as `string | null` from Drizzle, but every query in
 * this route includes `isNotNull(chatMessages.content)` in its WHERE
 * clause. `toChatMessage` asserts that invariant at the boundary rather
 * than silently coalescing a null into `""`, so a future regression that
 * drops the guard surfaces as a clear runtime error instead of empty
 * strings in the API response.
 */
interface ChatMessageRow {
  messageId: string;
  chatThreadId: string;
  role: string;
  content: string | null;
  createdAt: Date;
  sequenceNumber: number | null;
  runId: string | null;
}

/**
 * Narrow the DB `role` column (stored as free-form `text`) to the contract's
 * `"user" | "assistant"` enum at runtime. Throws on unexpected values so the
 * caller never receives a malformed response.
 */
const chatRoleSchema = z.enum(["user", "assistant"]);

function toChatMessage(row: ChatMessageRow): ChatSearchMessage {
  if (row.content === null) {
    // WHERE clauses in this route guarantee non-null content; hitting this
    // means the guard was removed upstream. Fail loudly rather than paper
    // over it with an empty string.
    throw new Error(
      "chat search invariant violated: message content is null despite isNotNull filter",
    );
  }
  return {
    messageId: row.messageId,
    chatThreadId: row.chatThreadId,
    role: chatRoleSchema.parse(row.role),
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    sequenceNumber: row.sequenceNumber,
    runId: row.runId,
  };
}

const messageColumns = {
  messageId: chatMessages.id,
  chatThreadId: chatMessages.chatThreadId,
  role: chatMessages.role,
  content: chatMessages.content,
  createdAt: chatMessages.createdAt,
  sequenceNumber: chatMessages.sequenceNumber,
  runId: chatMessages.runId,
};

const router = tsr.router(chatSearchContract, {
  search: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "chat-message:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);
    const { userId } = authCtx;
    const { keyword, agent, since, limit, before, after } = query;

    const pattern = `%${escapeLikePattern(keyword)}%`;
    const sinceDate = since ? new Date(since) : undefined;

    const matchConditions = [
      eq(chatThreads.userId, userId),
      eq(agentComposes.orgId, org.orgId),
      isNotNull(chatMessages.content),
      isNull(chatMessages.archivedAt),
      ilike(chatMessages.content, pattern),
    ];
    if (sinceDate) matchConditions.push(gte(chatMessages.createdAt, sinceDate));
    if (agent) matchConditions.push(eq(agentComposes.name, agent));

    // Fetch matches, over-fetch by 1 to detect hasMore.
    const matches = await globalThis.services.db
      .select({
        ...messageColumns,
        agentName: agentComposes.name,
      })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatMessages.chatThreadId, chatThreads.id))
      .innerJoin(
        agentComposes,
        eq(chatThreads.agentComposeId, agentComposes.id),
      )
      .where(and(...matchConditions))
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit + 1);

    const hasMore = matches.length > limit;
    const truncated = hasMore ? matches.slice(0, limit) : matches;

    // Context ordering note: we order by createdAt (non-null, indexed via
    // idx_chat_messages_thread_created) rather than sequenceNumber, which is
    // nullable for user/placeholder rows. Tradeoff: a pair of messages with
    // identical createdAt is a theoretical tie — acceptable since in practice
    // inserts are sub-millisecond apart and the index covers this well.
    const results = await Promise.all(
      truncated.map(async (m) => {
        const [contextBeforeRows, contextAfterRows] = await Promise.all([
          before > 0
            ? globalThis.services.db
                .select(messageColumns)
                .from(chatMessages)
                .where(
                  and(
                    eq(chatMessages.chatThreadId, m.chatThreadId),
                    lt(chatMessages.createdAt, m.createdAt),
                    isNotNull(chatMessages.content),
                    isNull(chatMessages.archivedAt),
                  ),
                )
                .orderBy(desc(chatMessages.createdAt))
                .limit(before)
            : Promise.resolve([] as ChatMessageRow[]),
          after > 0
            ? globalThis.services.db
                .select(messageColumns)
                .from(chatMessages)
                .where(
                  and(
                    eq(chatMessages.chatThreadId, m.chatThreadId),
                    gt(chatMessages.createdAt, m.createdAt),
                    isNotNull(chatMessages.content),
                    isNull(chatMessages.archivedAt),
                  ),
                )
                .orderBy(asc(chatMessages.createdAt))
                .limit(after)
            : Promise.resolve([] as ChatMessageRow[]),
        ]);

        return {
          chatThreadId: m.chatThreadId,
          agentName: m.agentName,
          matchedMessage: toChatMessage(m),
          // Flip DESC→ASC so contextBefore reads chronologically.
          contextBefore: contextBeforeRows.slice().reverse().map(toChatMessage),
          contextAfter: contextAfterRows.map(toChatMessage),
        };
      }),
    );

    return { status: 200 as const, body: { results, hasMore } };
  },
});

const handler = createHandler(chatSearchContract, router, {
  errorHandler: createSafeErrorHandler("zero-chat-search"),
});

export { handler as GET };
