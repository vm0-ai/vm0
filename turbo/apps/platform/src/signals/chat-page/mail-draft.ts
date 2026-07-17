import { command, computed, state, type Command, type Computed } from "ccstate";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroMailContract,
  type ZeroMailDraft,
} from "@vm0/api-contracts/contracts/zero-mail";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { pageSignal$ } from "../page-signal.ts";

export interface MailDraftFields {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}

export interface MailDraftSignals {
  readonly mailDraftId: string;
  readonly serverDraft$: Computed<Promise<ZeroMailDraft>>;
  readonly mutationDraft$: Computed<ZeroMailDraft | undefined>;
  readonly update$: Command<
    Promise<ZeroMailDraft>,
    [MailDraftFields, AbortSignal]
  >;
  readonly cancel$: Command<Promise<ZeroMailDraft>, [AbortSignal]>;
  readonly send$: Command<
    Promise<ZeroMailDraft>,
    [MailDraftFields, AbortSignal]
  >;
}

export interface MailDraftRegistrySignals {
  readonly mailDraftSignalsById$: Computed<
    ReadonlyMap<string, MailDraftSignals>
  >;
  readonly registerMailDraftMessages$: Command<
    void,
    [readonly PagedChatMessage[]]
  >;
}

export function newestMailDraft(
  first: ZeroMailDraft,
  second: ZeroMailDraft,
): ZeroMailDraft {
  return Date.parse(second.updatedAt) >= Date.parse(first.updatedAt)
    ? second
    : first;
}

function createMailDraftSignals(mailDraftId: string): MailDraftSignals {
  const internalMutationDraft$ = state<ZeroMailDraft | undefined>(undefined);
  const serverDraft$ = computed(async (get): Promise<ZeroMailDraft> => {
    const response = await accept(
      get(zeroClient$)(zeroMailContract).getDraft({
        params: { mailDraftId },
        fetchOptions: { signal: get(pageSignal$) },
      }),
      [200],
    );
    return response.body.mailDraft;
  });
  const mutationDraft$ = computed((get) => {
    return get(internalMutationDraft$);
  });

  const update$ = command(
    async (
      { get, set },
      fields: MailDraftFields,
      signal: AbortSignal,
    ): Promise<ZeroMailDraft> => {
      const client = get(zeroClient$)(zeroMailContract);
      const response = await accept(
        client.updateDraft({
          params: { mailDraftId },
          body: {
            to: [...fields.to],
            subject: fields.subject,
            body: fields.body,
          },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(internalMutationDraft$, (current) => {
        return current === undefined
          ? response.body.mailDraft
          : newestMailDraft(current, response.body.mailDraft);
      });
      return response.body.mailDraft;
    },
  );

  const cancel$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<ZeroMailDraft> => {
      const client = get(zeroClient$)(zeroMailContract);
      const response = await accept(
        client.cancelDraft({
          params: { mailDraftId },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(internalMutationDraft$, (current) => {
        return current === undefined
          ? response.body.mailDraft
          : newestMailDraft(current, response.body.mailDraft);
      });
      return response.body.mailDraft;
    },
  );

  const send$ = command(
    async (
      { get, set },
      fields: MailDraftFields,
      signal: AbortSignal,
    ): Promise<ZeroMailDraft> => {
      const client = get(zeroClient$)(zeroMailContract);
      const response = await accept(
        client.sendDraft({
          params: { mailDraftId },
          body: {
            to: [...fields.to],
            subject: fields.subject,
            body: fields.body,
          },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(internalMutationDraft$, (current) => {
        return current === undefined
          ? response.body.mailDraft
          : newestMailDraft(current, response.body.mailDraft);
      });
      return response.body.mailDraft;
    },
  );

  return {
    mailDraftId,
    serverDraft$,
    mutationDraft$,
    update$,
    cancel$,
    send$,
  };
}

/**
 * Thread-scoped registry of mail draft signals keyed by draft ID. Persistent
 * messages register their draft before entering the transcript, so every card
 * for the same draft reuses one signals object for the thread's lifetime.
 */
export function createMailDraftRegistry(): MailDraftRegistrySignals {
  const internalSignalsById$ = state<ReadonlyMap<string, MailDraftSignals>>(
    new Map(),
  );
  const mailDraftSignalsById$ = computed((get) => {
    return get(internalSignalsById$);
  });
  const registerMailDraftMessages$ = command(
    ({ get, set }, messages: readonly PagedChatMessage[]) => {
      const current = get(internalSignalsById$);
      let next: Map<string, MailDraftSignals> | undefined;
      for (const message of messages) {
        const { mailDraftId } = message;
        if (
          mailDraftId === undefined ||
          current.has(mailDraftId) ||
          next?.has(mailDraftId)
        ) {
          continue;
        }
        next ??= new Map(current);
        next.set(mailDraftId, createMailDraftSignals(mailDraftId));
      }
      if (next !== undefined) {
        set(internalSignalsById$, next);
      }
    },
  );
  return {
    mailDraftSignalsById$,
    registerMailDraftMessages$,
  };
}
