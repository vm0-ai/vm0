import { command } from "ccstate";
import { createElement } from "react";
import { ZeroAgentPhoneSettingsPage } from "../../views/zero-page/zero-agentphone-settings-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "./onboard-guard.ts";
import {
  resetAgentPhoneConnectUi$,
  setAgentPhoneConnectDialogOpen$,
} from "./zero-agentphone.ts";

export const setupAgentPhoneSettingsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetAgentPhoneConnectUi$);
    set(setAgentPhoneConnectDialogOpen$, false);
    set(updatePage$, createElement(ZeroAgentPhoneSettingsPage), "sidebar");
    set(updateDocumentTitle$, "AgentPhone");

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(onboardGuard$, signal),
    ]);
  },
);
