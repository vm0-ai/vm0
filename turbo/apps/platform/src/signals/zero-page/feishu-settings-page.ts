import { command } from "ccstate";
import { createElement } from "react";

import { ZeroFeishuSettingsPage } from "../../views/zero-page/feishu-card.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  reloadFeishuInstallations$,
  resetFeishuSettingsUi$,
  showFeishuSettingsResult$,
  startFeishuSettingsRealtime$,
} from "./zero-feishu.ts";
import { onboardGuard$ } from "./onboard-guard.ts";

export const setupFeishuSettingsPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetFeishuSettingsUi$);
    set(reloadFeishuInstallations$);
    set(showFeishuSettingsResult$);
    set(updatePage$, createElement(ZeroFeishuSettingsPage), "sidebar");
    set(updateDocumentTitle$, "Feishu");

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(onboardGuard$, signal),
      set(startFeishuSettingsRealtime$, signal),
    ]);
  },
);
