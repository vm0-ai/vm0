import { command, computed, state } from "ccstate";
import { zeroSlackChannelsContract, type SlackChannel } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { throwIfAbort } from "../utils.ts";

const slackChannelsState$ = state<SlackChannel[]>([]);
const slackChannelsLoaded$ = state(false);

/** True after the initial Slack channels fetch has completed. */
export const slackChannelsInitialized$ = computed((get) => {
  return get(slackChannelsLoaded$);
});

export const fetchSlackChannels$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroSlackChannelsContract);
    // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove — use accept() error propagation
    try {
      const result = await accept(client.list(), [200]);
      set(slackChannelsState$, result.body.channels);
    } catch (error) {
      throwIfAbort(error);
      set(slackChannelsState$, []);
    } finally {
      set(slackChannelsLoaded$, true);
    }
  },
);
