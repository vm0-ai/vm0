import { eq } from "drizzle-orm";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { buildGenerationTemplatePrompt } from "./generation-template-prompt";

async function getStoredThreadGenerationTemplate(
  db: Db,
  threadId: string,
): Promise<GenerationTemplateRequest | null> {
  const [thread] = await db
    .select({ generationTemplate: chatThreads.generationTemplate })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return thread?.generationTemplate ?? null;
}

async function persistThreadGenerationTemplate(
  db: Db,
  threadId: string,
  generationTemplate: GenerationTemplateRequest,
): Promise<void> {
  await db
    .update(chatThreads)
    .set({ generationTemplate, updatedAt: nowDate() })
    .where(eq(chatThreads.id, threadId));
}

/**
 * Resolve the generation-template system prompt for a chat run from thread-sticky
 * state.
 *
 * Per message: an explicit selection (the style tag attached this turn) wins and
 * is persisted to the thread; otherwise the thread's previously persisted
 * template is inherited, so follow-up messages keep the style without restating
 * it and the server injects it deterministically every run.
 *
 * There is intentionally no org/global default and persistence is thread-scoped:
 * a thread with no persisted template (e.g. a brand-new thread) resolves to "",
 * so new sessions start clean with no cross-session carry-over.
 *
 * A stored template that no longer resolves (e.g. its style was removed from the
 * registry after it was persisted) degrades to "" rather than failing the run.
 */
export async function resolveThreadGenerationTemplatePrompt(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly explicit: GenerationTemplateRequest | null | undefined;
}): Promise<string> {
  if (args.explicit) {
    await persistThreadGenerationTemplate(
      args.db,
      args.threadId,
      args.explicit,
    );
  }
  const effective =
    args.explicit ??
    (await getStoredThreadGenerationTemplate(args.db, args.threadId));
  if (!effective) {
    return "";
  }
  const built = buildGenerationTemplatePrompt(effective);
  return built.status === "resolved" ? built.prompt : "";
}
