import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";

interface SlackChannel {
  id: string;
  name: string;
}

const slackChannelsState$ = state<SlackChannel[]>([]);

export const slackChannels$ = computed((get) => get(slackChannelsState$));

export const fetchSlackChannels$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/zero/slack/channels");
  if (!response.ok) {
    set(slackChannelsState$, []);
    return;
  }

  const data = (await response.json()) as { channels: SlackChannel[] };
  set(slackChannelsState$, data.channels);
});
