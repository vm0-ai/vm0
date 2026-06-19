import { command, state, type Command } from "ccstate";
import { delay } from "signal-timers";
import { zeroAgentDraftContract } from "@vm0/api-contracts/contracts/zero-agents";
import { accept } from "../../lib/accept.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { zeroClient$ } from "../api-client.ts";
import { collectSuccessfulAttachmentInfos } from "../chat-page/resolve-draft-attachments.ts";
import { resetSignal } from "../utils.ts";
import {
  createDraftSignals,
  createRestoredAttachment,
  type DraftSignals,
} from "./chat-draft.ts";

const DRAFT_SYNC_DEBOUNCE_MS = 500;

interface AgentDraftEntry {
  readonly draft: DraftSignals;
  readonly queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  readonly cancelDraftSync$: Command<void, []>;
  readonly flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
}

export interface EnsuredAgentDraft extends AgentDraftEntry {
  readonly isNew: boolean;
}

const agentDraftCache$ = state(new Map<string, AgentDraftEntry>());

function createAgentDraftSync(agentId: string, draft: DraftSignals) {
  const draftSyncReset$ = resetSignal();

  const patchDraft$ = command(
    async (
      { get },
      content: string | null,
      attachments: ReturnType<typeof collectSuccessfulAttachmentInfos>,
      signal: AbortSignal,
    ) => {
      const client = get(zeroClient$)(zeroAgentDraftContract);
      await accept(
        client.patch({
          params: { id: agentId },
          body: {
            draftContent: content,
            draftAttachments:
              attachments && attachments.length > 0
                ? attachments.map((r) => {
                    return {
                      id: r.info.id,
                      url: r.info.url,
                      filename: r.attachment.filename,
                      contentType: r.attachment.contentType,
                      size: r.attachment.size,
                    };
                  })
                : null,
          },
          fetchOptions: { signal },
        }),
        [204],
      );
    },
  );

  const debouncedSyncDraft$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      await delay(DRAFT_SYNC_DEBOUNCE_MS, { signal });
      signal.throwIfAborted();

      const content = get(draft.input$).trim() || null;
      const draftAttachments = get(draft.attachments$);
      const infos = await Promise.allSettled(
        draftAttachments.map((attachment) => {
          return get(attachment.fileInfo$);
        }),
      );
      signal.throwIfAborted();

      await set(
        patchDraft$,
        content,
        collectSuccessfulAttachmentInfos(draftAttachments, infos),
        signal,
      );
    },
  );

  const queueDraftSync$ = command(async ({ set }, signal: AbortSignal) => {
    const debouncedSignal = set(draftSyncReset$, signal);
    await set(debouncedSyncDraft$, debouncedSignal);
  });

  const cancelDraftSync$ = command(({ set }) => {
    set(draftSyncReset$);
  });

  const flushDraftClear$ = command(async ({ set }, signal: AbortSignal) => {
    set(draftSyncReset$);
    await set(patchDraft$, null, [], signal);
  });

  return { queueDraftSync$, cancelDraftSync$, flushDraftClear$ };
}

export const ensureAgentDraft$ = command(
  ({ get, set }, agentId: string): EnsuredAgentDraft => {
    const cache = get(agentDraftCache$);
    const existing = cache.get(agentId);
    if (existing) {
      return { ...existing, isNew: false };
    }

    const draft = createDraftSignals();
    const sync = createAgentDraftSync(agentId, draft);
    const entry: AgentDraftEntry = { draft, ...sync };
    const next = new Map(cache);
    next.set(agentId, entry);
    set(agentDraftCache$, next);
    return { ...entry, isNew: true };
  },
);

export const loadAgentDraft$ = command(
  async (
    { get, set },
    agentId: string,
    draft: DraftSignals,
    isNew: boolean,
    signal: AbortSignal,
  ) => {
    if (!isNew) {
      return;
    }

    const hasLocalDraft =
      get(draft.input$).trim() !== "" || get(draft.attachments$).length > 0;
    if (hasLocalDraft) {
      return;
    }

    const client = get(zeroClient$)(zeroAgentDraftContract);
    const result = await accept(
      client.get({
        params: { id: agentId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    const attachments = result.body.draftAttachments ?? [];
    const hasServerDraft =
      Boolean(result.body.draftContent) || attachments.length > 0;
    if (!hasServerDraft) {
      return;
    }

    set(
      draft.seed$,
      result.body.draftContent ?? "",
      attachments.map(createRestoredAttachment),
    );
  },
);

export const queueCurrentAgentDraftSync$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const agentId = await get(currentChatAgentRecordId$);
    signal.throwIfAborted();
    if (!agentId) {
      return;
    }

    const entry = set(ensureAgentDraft$, agentId);
    await set(entry.queueDraftSync$, signal);
  },
);

export const clearAgentDraftById$ = command(
  async ({ set }, agentId: string, signal: AbortSignal) => {
    const entry = set(ensureAgentDraft$, agentId);
    set(entry.draft.clear$);
    await set(entry.flushDraftClear$, signal);
  },
);
