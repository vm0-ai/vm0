import { command, state, type Command } from "ccstate";
import { delay } from "signal-timers";
import {
  agentDraftContract,
  agentDraftResponseSchema,
} from "@okouai/api-contracts/contracts/agent-draft";
import type {
  DraftVoice,
  PersistedAttachment,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { collectSuccessfulAttachmentInfos } from "../chat-page/resolve-draft-attachments.ts";
import { resetSignal } from "../utils.ts";
import {
  createDraftSignals,
  createRestoredAttachment,
  type DraftSignals,
  type RestorableAttachment,
} from "./chat-draft.ts";
import {
  buildDraftPersistencePayload,
  type DraftPersistencePayload,
} from "./draft-persistence.ts";
import {
  draftToEditorDoc,
  messageDocumentToPrompt,
} from "./user-message-document-codec.ts";

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

interface RestoredAgentDraftState {
  readonly content: string;
  readonly userMessage: UserMessageDocument | null;
  readonly draftVoice: DraftVoice | null;
  readonly attachments: RestorableAttachment[];
}

const agentDraftCache$ = state(new Map<string, AgentDraftEntry>());

function userMessageAgentDraftAttachments(
  document: UserMessageDocument,
  attachments: readonly PersistedAttachment[],
): RestorableAttachment[] {
  const attachmentById = new Map(
    attachments.map((attachment) => {
      return [attachment.id, attachment] as const;
    }),
  );
  return document.parts.flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    const attachment = attachmentById.get(part.fileId);
    return attachment
      ? [
          {
            ...attachment,
            ...(part.annotatedFileId
              ? { annotatedFileId: part.annotatedFileId }
              : {}),
            ...(part.annotations ? { annotations: part.annotations } : {}),
          },
        ]
      : [];
  });
}

function userMessageAgentDraftState(args: {
  readonly draftUserMessage?: UserMessageDocument | null;
  readonly draftVoice?: DraftVoice | null;
  readonly draftAttachments: PersistedAttachment[] | null;
}): RestoredAgentDraftState | null {
  const document = args.draftUserMessage ?? null;
  // A new App may receive a pre-#31562 API response during serving or rollback.
  // Remove this new-App -> old-API bridge with #31612 after that window closes.
  const draftVoice = args.draftVoice ?? null;
  if (draftToEditorDoc(document, draftVoice) === null) {
    return null;
  }
  const content = document ? messageDocumentToPrompt(document) : "";
  if (content === null) {
    return null;
  }
  return {
    content,
    userMessage: document,
    draftVoice,
    attachments: document
      ? userMessageAgentDraftAttachments(document, args.draftAttachments ?? [])
      : [],
  };
}

function createAgentDraftSync(agentId: string, draft: DraftSignals) {
  const draftSyncReset$ = resetSignal();

  const patchDraft$ = command(
    async ({ get }, payload: DraftPersistencePayload, signal: AbortSignal) => {
      const client = get(apiClient$)(agentDraftContract);
      await accept(
        client.patch({
          params: { id: agentId },
          body: {
            draftUserMessage: payload.userMessage,
            ...(payload.draftVoice ? { draftVoice: payload.draftVoice } : {}),
            draftAttachments: payload.attachments,
          },
          fetchOptions: { signal },
        }),
        [200, 204],
      );
    },
  );

  const debouncedSyncDraft$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      await delay(DRAFT_SYNC_DEBOUNCE_MS, { signal });
      signal.throwIfAborted();

      const draftAttachments = get(draft.attachments$);
      const infos = await Promise.allSettled(
        draftAttachments.map((attachment) => {
          return get(attachment.fileInfo$);
        }),
      );
      signal.throwIfAborted();
      const attachments = collectSuccessfulAttachmentInfos(
        draftAttachments,
        infos,
      ).map((result) => {
        const annotations = get(result.attachment.annotations$);
        const annotatedFileId = get(result.attachment.annotatedFileId$);
        return {
          id: result.info.id,
          url: result.info.url,
          filename: result.attachment.filename,
          contentType: result.info.contentType,
          size: result.attachment.size,
          ...(annotatedFileId ? { annotatedFileId } : {}),
          ...(annotations ? { annotations } : {}),
        };
      });
      const payload = buildDraftPersistencePayload({
        input: get(draft.input$),
        editorDocument: set(draft.readEditorDocument$),
        generationTemplate: get(draft.generationTemplate$),
        attachments,
      });

      await set(patchDraft$, payload, signal);
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
    await set(
      patchDraft$,
      { userMessage: null, draftVoice: null, attachments: null },
      signal,
    );
  });

  return { queueDraftSync$, cancelDraftSync$, flushDraftClear$ };
}

export function createAgentDraftSignals(agentId: string): EnsuredAgentDraft {
  const draft = createDraftSignals();
  const sync = createAgentDraftSync(agentId, draft);
  const entry: AgentDraftEntry = { draft, ...sync };
  return { ...entry, isNew: true };
}

export const ensureAgentDraft$ = command(
  ({ get, set }, agentId: string): EnsuredAgentDraft => {
    const cache = get(agentDraftCache$);
    const existing = cache.get(agentId);
    if (existing) {
      return { ...existing, isNew: false };
    }

    const created = createAgentDraftSignals(agentId);
    const entry: AgentDraftEntry = {
      draft: created.draft,
      queueDraftSync$: created.queueDraftSync$,
      cancelDraftSync$: created.cancelDraftSync$,
      flushDraftClear$: created.flushDraftClear$,
    };
    const next = new Map(cache);
    next.set(agentId, entry);
    set(agentDraftCache$, next);
    return created;
  },
);

export const loadAgentDraft$ = command(
  async (
    { get, set },
    agentId: string,
    agentDraft: EnsuredAgentDraft,
    signal: AbortSignal,
  ) => {
    const { draft, isNew } = agentDraft;
    if (!isNew) {
      return;
    }

    const hasLocalDraft = (): boolean => {
      return (
        get(draft.input$).trim() !== "" ||
        get(draft.generationTemplate$) !== undefined ||
        get(draft.attachments$).length > 0
      );
    };
    if (hasLocalDraft()) {
      return;
    }

    const client = get(apiClient$)(agentDraftContract);
    const result = await accept(
      client.get({
        params: { id: agentId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    // The composer is interactive while the remote draft loads. Preserve any
    // input the user added after the request started instead of replacing it
    // with the older server snapshot.
    if (hasLocalDraft()) {
      return;
    }

    const response = agentDraftResponseSchema.parse(result.body);
    const restoredDraft = userMessageAgentDraftState(response);
    if (!restoredDraft) {
      return;
    }
    const hasServerDraft =
      restoredDraft.content.length > 0 ||
      restoredDraft.userMessage !== null ||
      restoredDraft.draftVoice !== null ||
      restoredDraft.attachments.length > 0;
    if (!hasServerDraft) {
      return;
    }

    const removedUnavailableAttachments = await set(
      draft.seed$,
      {
        content: restoredDraft.content,
        userMessage: restoredDraft.userMessage,
        draftVoice: restoredDraft.draftVoice,
        generationTemplate: undefined,
        attachments: restoredDraft.attachments.map(createRestoredAttachment),
      },
      signal,
    );
    if (removedUnavailableAttachments) {
      await set(agentDraft.queueDraftSync$, signal);
    }
  },
);

export const clearAgentDraftById$ = command(
  async ({ set }, agentId: string, signal: AbortSignal) => {
    const entry = set(ensureAgentDraft$, agentId);
    set(entry.draft.clear$);
    await set(entry.flushDraftClear$, signal);
  },
);
