import { command, computed, state } from "ccstate";
import {
  zeroMailContract,
  type ZeroMailDraft,
} from "@vm0/api-contracts/contracts/zero-mail";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

export interface MailDraftFields {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}

interface MailDraftCommandArgs {
  readonly threadId: string;
  readonly messageId: string;
}

interface SaveMailDraftCommandArgs extends MailDraftCommandArgs {
  readonly fields: MailDraftFields;
}

const internalMailDraftOverrides$ = state<Record<string, ZeroMailDraft>>({});

export const mailDraftOverrides$ = computed((get) => {
  return get(internalMailDraftOverrides$);
});

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
          threadId: args.threadId,
          messageId: args.messageId,
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
      return { ...current, [args.messageId]: response.body.mailDraft };
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
          threadId: args.threadId,
          messageId: args.messageId,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalMailDraftOverrides$, (current) => {
      return { ...current, [args.messageId]: response.body.mailDraft };
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
          threadId: args.threadId,
          messageId: args.messageId,
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
      return { ...current, [args.messageId]: response.body.mailDraft };
    });
    return response.body.mailDraft;
  },
);
