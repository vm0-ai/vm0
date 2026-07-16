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

interface MailDraftCommandArgs {
  readonly mailDraftId: string;
}

interface SaveMailDraftCommandArgs extends MailDraftCommandArgs {
  readonly fields: MailDraftFields;
}

const internalMailDraftOverrides$ = state<Record<string, ZeroMailDraft>>({});

export const mailDraftOverrides$ = computed((get) => {
  return get(internalMailDraftOverrides$);
});

export type MailDraftResource = Computed<Promise<ZeroMailDraft>>;

export interface MailDraftLoaderSignals {
  readonly mailDraftById$: Computed<ReadonlyMap<string, MailDraftResource>>;
  readonly registerMailDraftMessages$: Command<
    void,
    [readonly PagedChatMessage[]]
  >;
}

export function createMailDraftLoaderSignals(): MailDraftLoaderSignals {
  const internalMailDraftById$ = state<ReadonlyMap<string, MailDraftResource>>(
    new Map(),
  );
  const mailDraftById$ = computed((get) => {
    return get(internalMailDraftById$);
  });
  const registerMailDraftMessages$ = command(
    ({ get, set }, messages: readonly PagedChatMessage[]) => {
      const current = get(internalMailDraftById$);
      let next: Map<string, MailDraftResource> | undefined;
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
        next.set(
          mailDraftId,
          computed(async (get) => {
            const response = await accept(
              get(zeroClient$)(zeroMailContract).getDraft({
                params: { mailDraftId },
                fetchOptions: { signal: get(pageSignal$) },
              }),
              [200],
            );
            return response.body.mailDraft;
          }),
        );
      }
      if (next !== undefined) {
        set(internalMailDraftById$, next);
      }
    },
  );
  return {
    mailDraftById$,
    registerMailDraftMessages$,
  };
}

export const updateMailDraft$ = command(
  async (
    { get, set },
    args: SaveMailDraftCommandArgs,
    signal: AbortSignal,
  ): Promise<ZeroMailDraft> => {
    const client = get(zeroClient$)(zeroMailContract);
    const response = await accept(
      client.updateDraft({
        params: {
          mailDraftId: args.mailDraftId,
        },
        body: {
          to: [...args.fields.to],
          subject: args.fields.subject,
          body: args.fields.body,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalMailDraftOverrides$, (current) => {
      return { ...current, [args.mailDraftId]: response.body.mailDraft };
    });
    return response.body.mailDraft;
  },
);

export const cancelMailDraft$ = command(
  async (
    { get, set },
    args: MailDraftCommandArgs,
    signal: AbortSignal,
  ): Promise<ZeroMailDraft> => {
    const client = get(zeroClient$)(zeroMailContract);
    const response = await accept(
      client.cancelDraft({
        params: {
          mailDraftId: args.mailDraftId,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalMailDraftOverrides$, (current) => {
      return { ...current, [args.mailDraftId]: response.body.mailDraft };
    });
    return response.body.mailDraft;
  },
);

export const sendMailDraft$ = command(
  async (
    { get, set },
    args: SaveMailDraftCommandArgs,
    signal: AbortSignal,
  ): Promise<ZeroMailDraft> => {
    const client = get(zeroClient$)(zeroMailContract);
    const response = await accept(
      client.sendDraft({
        params: {
          mailDraftId: args.mailDraftId,
        },
        body: {
          to: [...args.fields.to],
          subject: args.fields.subject,
          body: args.fields.body,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalMailDraftOverrides$, (current) => {
      return { ...current, [args.mailDraftId]: response.body.mailDraft };
    });
    return response.body.mailDraft;
  },
);
