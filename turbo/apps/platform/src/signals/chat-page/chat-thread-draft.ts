import { command, computed, type Command, type Computed } from "ccstate";
import type { ChatThreadDraft } from "@okouai/api-contracts/contracts/chat-threads";
import {
  createRestoredAttachment,
  type DraftSignals,
} from "../okou-page/chat-draft.ts";
import {
  draftToEditorDoc,
  messageDocumentToPrompt,
  userMessageDraftAttachments,
  type RestoredDraftState,
} from "../okou-page/user-message-document-codec.ts";

function userMessageDraftState(
  threadDraft: ChatThreadDraft,
): RestoredDraftState | null {
  const document = threadDraft.draftUserMessage;
  if (draftToEditorDoc(document) === null) {
    return null;
  }
  const content = document ? messageDocumentToPrompt(document) : "";
  if (content === null) {
    return null;
  }
  return {
    content,
    userMessage: document,
    attachments: document
      ? userMessageDraftAttachments(
          document,
          threadDraft.draftAttachments ?? [],
        )
      : [],
  };
}

export function createThreadDraftLoad(
  threadDraft$: Computed<Promise<ChatThreadDraft | null>>,
  draft: DraftSignals,
  save$: Command<Promise<void>, [AbortSignal]>,
): Command<Promise<void>, [AbortSignal]> {
  const hasLocalDraft$ = computed((get) => {
    return (
      get(draft.hasInput$) ||
      get(draft.generationTemplate$) !== undefined ||
      get(draft.attachments$).length > 0
    );
  });
  const load$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (get(hasLocalDraft$)) {
      return;
    }
    const threadDraft = await get(threadDraft$);
    signal.throwIfAborted();

    if (!threadDraft || get(hasLocalDraft$)) {
      return;
    }

    const restoredDraft = userMessageDraftState(threadDraft);
    if (!restoredDraft) {
      return;
    }
    const hasDraft =
      restoredDraft.content.length > 0 ||
      restoredDraft.userMessage !== null ||
      restoredDraft.attachments.length > 0;
    if (hasDraft) {
      const restoredAttachments = restoredDraft.attachments.map(
        createRestoredAttachment,
      );
      const removedUnavailableAttachments = await set(
        draft.seed$,
        {
          content: restoredDraft.content,
          userMessage: restoredDraft.userMessage,
          generationTemplate: undefined,
          attachments: restoredAttachments,
        },
        signal,
      );
      if (removedUnavailableAttachments) {
        await set(save$, signal);
      }
    }
  });
  return command(async ({ set }, signal: AbortSignal) => {
    await set(draft.hydrate$, load$, signal);
  });
}
