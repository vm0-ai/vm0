import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { chatMessages } from "@vm0/db/schema/chat-message";
import type { Db } from "../external/db";
import { visibleChatMessageCondition } from "../services/zero-chat-message-shared.service";
import {
  buildGenerationTemplatePrompt,
  describeGenerationTemplateSelection,
} from "./generation-template-prompt";

/**
 * Resolve the generation-template system prompt for a chat run.
 *
 * One-shot only: the prompt is built from the selection attached to *this*
 * message and nothing else. There is no thread-sticky persistence — a
 * follow-up message that doesn't reattach a template resolves to "", and the
 * agent must rely on the marker embedded in the replayed prior-run text (see
 * buildWebChatPriorRunsContext) to keep using the same template across turns.
 * This trades a DB-backed "never expires" default for one signal that lives
 * entirely in-context: no separate store to fall out of sync with what the
 * agent actually sees.
 */
export function resolveThreadGenerationTemplatePrompt(args: {
  readonly explicit: GenerationTemplateRequest | null | undefined;
  readonly presentationRunbookEnabled?: boolean;
}): string {
  if (!args.explicit) {
    return "";
  }
  const built = buildGenerationTemplatePrompt(args.explicit, {
    presentationRunbookEnabled: args.presentationRunbookEnabled,
  });
  return built.status === "resolved" ? built.prompt : "";
}

/**
 * Fallback for the one gap the in-context replay marker can't cover on its
 * own: the general conversation replay (buildWebChatPriorRunsContext) is
 * skipped whenever the thread has an incomplete round, because that case
 * resumes an existing CLI session which already has the history natively
 * (see prepareRecentChatContext / buildQueuedPriorContext). A generation
 * template selection isn't part of that native session history the same way
 * — it only ever reached the model as narrated text — so when the replay is
 * skipped, a selection from before the incomplete round would otherwise
 * disappear with no trace. This does one direct read of the most recent
 * selection (no separate stored/merged state) and surfaces it only for that
 * gap; call with `replaySuppressed: false` and it is a no-op.
 */
export async function fallbackGenerationTemplateNote(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly explicit: GenerationTemplateRequest | null | undefined;
  readonly replaySuppressed: boolean;
}): Promise<string> {
  if (args.explicit || !args.replaySuppressed) {
    return "";
  }
  // Workflow selections are excluded in SQL, not filtered afterward — the most
  // recent selection overall might be a workflow one, and filtering post-query
  // would incorrectly hide an earlier non-workflow selection behind it instead
  // of falling through to find it.
  const [row] = await args.db
    .select({ generationTemplate: chatMessages.generationTemplate })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, args.threadId),
        eq(chatMessages.role, "user"),
        isNotNull(chatMessages.generationTemplate),
        sql`(${chatMessages.generationTemplate}->>'type') IS DISTINCT FROM 'workflow'`,
        visibleChatMessageCondition(),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  if (!row?.generationTemplate) {
    return "";
  }
  const description = describeGenerationTemplateSelection(
    row.generationTemplate,
  );
  return description
    ? [
        "# Prior Template Selection",
        "",
        `Earlier in this thread, the user selected a template — ${description}. The usual replay of recent turns is skipped for this run because it resumes an existing session; this note exists only so that fact isn't lost.`,
      ].join("\n")
    : "";
}
