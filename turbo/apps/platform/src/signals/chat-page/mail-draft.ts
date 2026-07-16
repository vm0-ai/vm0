import { command, computed, state, type Computed } from "ccstate";
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

export interface MailDraftLoaderSignals {
  readonly byId: (mailDraftId: string) => Computed<Promise<ZeroMailDraft>>;
}

export function createMailDraftLoaderSignals(): MailDraftLoaderSignals {
  const cache = new Map<string, Computed<Promise<ZeroMailDraft>>>();
  return {
    byId: (mailDraftId) => {
      const existing = cache.get(mailDraftId);
      if (existing) {
        return existing;
      }
      const mailDraft$ = computed(async (get) => {
        const response = await accept(
          get(zeroClient$)(zeroMailContract).getDraft({
            params: { mailDraftId },
            fetchOptions: { signal: get(pageSignal$) },
          }),
          [200],
        );
        return response.body.mailDraft;
      });
      cache.set(mailDraftId, mailDraft$);
      return mailDraft$;
    },
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
