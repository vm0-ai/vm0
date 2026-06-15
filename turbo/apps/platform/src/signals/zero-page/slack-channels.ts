import { command, state } from "ccstate";
import {
  zeroSlackChannelsContract,
  type SlackChannel,
} from "@vm0/api-contracts/contracts/zero-slack-channels";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const slackChannelsState$ = state<SlackChannel[]>([]);
const slackChannelsLoaded$ = state(false);

export const fetchSlackChannels$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroSlackChannelsContract);
    const result = await accept(client.list(), [200], { toast: false });
    set(slackChannelsState$, result.body.channels);
    set(slackChannelsLoaded$, true);
  },
);
