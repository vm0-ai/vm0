import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";

const internalChatThreadOnlyUnread$ = state(false);

export const chatThreadOnlyUnread$ = computed((get) => {
  const features = get(featureSwitch$);
  return (
    (features[FeatureSwitchKey.AgentUnreadIndicators] ?? false) &&
    get(internalChatThreadOnlyUnread$)
  );
});

export const setChatThreadOnlyUnread$ = command(
  ({ set }, onlyUnread: boolean) => {
    set(internalChatThreadOnlyUnread$, onlyUnread);
  },
);
