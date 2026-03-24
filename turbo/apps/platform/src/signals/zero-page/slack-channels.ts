import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { logger } from "../log.ts";

const log = logger("slack-channels");

interface SlackChannel {
  id: string;
  name: string;
}

const slackChannelsState$ = state<SlackChannel[]>([]);
const slackChannelsLoaded$ = state(false);

export const slackChannels$ = computed((get) => get(slackChannelsState$));

/** True after the initial Slack channels fetch has completed. */
export const slackChannelsInitialized$ = computed((get) =>
  get(slackChannelsLoaded$),
);

export const fetchSlackChannels$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/zero/slack/channels");
  if (!response.ok) {
    log.warn("Failed to fetch Slack channels", { status: response.status });
    set(slackChannelsState$, []);
  } else {
    const data = (await response.json()) as { channels: SlackChannel[] };
    set(slackChannelsState$, data.channels);
  }
  set(slackChannelsLoaded$, true);
});
