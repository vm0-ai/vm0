import { command, computed, state } from "ccstate";
import { zeroSlackChannelsContract, type SlackChannel } from "@vm0/core";
import { logger } from "../log.ts";
import { zeroClient$ } from "../api-client.ts";

const log = logger("slack-channels");

const slackChannelsState$ = state<SlackChannel[]>([]);
const slackChannelsLoaded$ = state(false);

export const slackChannels$ = computed((get) => get(slackChannelsState$));

/** True after the initial Slack channels fetch has completed. */
export const slackChannelsInitialized$ = computed((get) =>
  get(slackChannelsLoaded$),
);

export const fetchSlackChannels$ = command(async ({ get, set }) => {
  const client = get(zeroClient$)(zeroSlackChannelsContract);
  const result = await client.list();
  if (result.status !== 200) {
    log.warn("Failed to fetch Slack channels", { status: result.status });
    set(slackChannelsState$, []);
  } else {
    set(slackChannelsState$, result.body.channels);
  }
  set(slackChannelsLoaded$, true);
});
