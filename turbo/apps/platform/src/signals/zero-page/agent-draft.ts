import { command, state, type Command } from "ccstate";
import { delay } from "signal-timers";
import {
  zeroAgentDraftContract,
  zeroAgentDraftResponseSchema,
} from "@vm0/api-contracts/contracts/zero-agents";
import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { withPrecedingDraftStructuredPrompt } from "@vm0/api-contracts/contracts/user-message-rollout";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { zeroClient$ } from "../api-client.ts";
import { collectSuccessfulAttachmentInfos } from "../chat-page/resolve-draft-attachments.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { resetSignal } from "../utils.ts";
import {
  createDraftSignals,
  createRestoredAttachment,
  type DraftSignals,
} from "./chat-draft.ts";
import {
  buildDraftPersistencePayload,
  type DraftPersistencePayload,
} from "./draft-persistence.ts";
import {
  messageDocumentToEditorDoc,
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
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly attachments: PersistedAttachment[];
}

const agentDraftCache$ = state(new Map<string, AgentDraftEntry>());

function legacyAgentDraftState(args: {
  readonly draftContent: string | null;
  readonly draftAttachments: PersistedAttachment[] | null;
}): RestoredAgentDraftState {
  return {
    content: args.draftContent ?? "",
    userMessage: null,
    generationTemplate: undefined,
    attachments: args.draftAttachments ?? [],
  };
}

function userMessageAgentDraftAttachments(
  document: UserMessageDocument,
  attachments: readonly PersistedAttachment[],
): PersistedAttachment[] {
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
    return attachment ? [attachment] : [];
  });
}

function userMessageAgentDraftState(
  args: {
    readonly draftContent: string | null;
    readonly draftUserMessage?: UserMessageDocument | null;
    readonly draftAttachments: PersistedAttachment[] | null;
  },
  inlineTemplatesEnabled: boolean,
): RestoredAgentDraftState | null {
  const document = args.draftUserMessage;
  if (
    !document ||
    messageDocumentToEditorDoc(document, {
      inlineTemplates: inlineTemplatesEnabled,
    }) === null
  ) {
    return null;
  }
  const content = messageDocumentToPrompt(document, {
    inlineTemplates: inlineTemplatesEnabled,
  });
  if (content === null) {
    return null;
  }
  const generationTemplate = document.parts.find((part) => {
    return part.type === "template";
  });
  return {
    content,
    userMessage: document,
    generationTemplate:
      !inlineTemplatesEnabled && generationTemplate?.type === "template"
        ? generationTemplate.template
        : undefined,
    attachments: userMessageAgentDraftAttachments(
      document,
      args.draftAttachments ?? [],
    ),
  };
}

function createAgentDraftSync(agentId: string, draft: DraftSignals) {
  const draftSyncReset$ = resetSignal();

  const patchDraft$ = command(
    async ({ get }, payload: DraftPersistencePayload, signal: AbortSignal) => {
      const client = get(zeroClient$)(zeroAgentDraftContract);
      await accept(
        client.patch({
          params: { id: agentId },
          body: withPrecedingDraftStructuredPrompt({
            draftContent: payload.content,
            draftUserMessage: payload.userMessage,
            draftAttachments: payload.attachments,
          }),
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
        return {
          id: result.info.id,
          url: result.info.url,
          filename: result.attachment.filename,
          contentType: result.attachment.contentType,
          size: result.attachment.size,
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
      { content: null, userMessage: null, attachments: null },
      signal,
    );
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

    const response = zeroAgentDraftResponseSchema.parse(result.body);
    const features = get(featureSwitch$);
    const userMessageEnabled =
      features[FeatureSwitchKey.StructuredPrompt] ?? false;
    const inlineTemplatesEnabled =
      userMessageEnabled &&
      (features[FeatureSwitchKey.StructuredPromptInlineTemplates] ?? false);
    const restoredDraft = userMessageEnabled
      ? (userMessageAgentDraftState(response, inlineTemplatesEnabled) ??
        legacyAgentDraftState(response))
      : legacyAgentDraftState(response);
    const hasServerDraft =
      restoredDraft.content.length > 0 ||
      restoredDraft.userMessage !== null ||
      restoredDraft.attachments.length > 0;
    if (!hasServerDraft) {
      return;
    }

    set(draft.seed$, {
      content: restoredDraft.content,
      userMessage: restoredDraft.userMessage,
      generationTemplate: restoredDraft.generationTemplate,
      attachments: restoredDraft.attachments.map(createRestoredAttachment),
    });
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
