import { eq } from "drizzle-orm";
import type {
  GenerationTemplateRequest,
  GenerationTemplateType,
  ThreadGenerationTemplates,
} from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { buildGenerationTemplatePrompt } from "./generation-template-prompt";

// Fixed order so the combined prompt is deterministic regardless of the order in
// which the user attached each type.
const TEMPLATE_TYPE_ORDER: readonly GenerationTemplateType[] = [
  "illustration",
  "video",
  "presentation",
];

async function getStoredThreadGenerationTemplates(
  db: Db,
  threadId: string,
): Promise<ThreadGenerationTemplates> {
  const [thread] = await db
    .select({ generationTemplate: chatThreads.generationTemplate })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return thread?.generationTemplate ?? {};
}

async function persistThreadGenerationTemplates(
  db: Db,
  threadId: string,
  templates: ThreadGenerationTemplates,
): Promise<void> {
  await db
    .update(chatThreads)
    .set({ generationTemplate: templates, updatedAt: nowDate() })
    .where(eq(chatThreads.id, threadId));
}

/**
 * Resolve the generation-template system prompt for a chat run from thread-sticky
 * state, supporting multiple template types at once.
 *
 * Per message: an explicit selection (the tag attached this turn) updates only
 * its own type's slot and is persisted, leaving the thread's other types intact;
 * those other persisted templates are inherited. So one thread can keep an
 * illustration style and a video preset active together, follow-ups keep them
 * without restating, and the server injects every active type deterministically
 * on each run.
 *
 * There is intentionally no org/global default and persistence is thread-scoped:
 * a thread with no persisted templates (e.g. a brand-new thread) resolves to "",
 * so new sessions start clean with no cross-session carry-over. A stored template
 * whose style was removed from the registry degrades to no prompt for that type
 * rather than failing the run.
 */
export async function resolveThreadGenerationTemplatePrompt(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly explicit: GenerationTemplateRequest | null | undefined;
}): Promise<string> {
  const stored = await getStoredThreadGenerationTemplates(
    args.db,
    args.threadId,
  );
  const effective: ThreadGenerationTemplates = args.explicit
    ? { ...stored, [args.explicit.type]: args.explicit }
    : stored;
  if (args.explicit) {
    await persistThreadGenerationTemplates(args.db, args.threadId, effective);
  }
  return TEMPLATE_TYPE_ORDER.map((type) => {
    const template = effective[type];
    if (!template) {
      return "";
    }
    const built = buildGenerationTemplatePrompt(template);
    return built.status === "resolved" ? built.prompt : "";
  })
    .filter((prompt) => {
      return prompt.length > 0;
    })
    .join("\n\n");
}
