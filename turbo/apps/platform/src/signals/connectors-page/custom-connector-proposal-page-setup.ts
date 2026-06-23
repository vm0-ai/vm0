import { command } from "ccstate";
import { createElement } from "react";
import { ZeroCustomConnectorProposalPage } from "../../views/zero-page/zero-custom-connector-proposal-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { resetCustomConnectorProposalForm$ } from "./custom-connector-proposal.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";

export const setupCustomConnectorProposalPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (await set(onboardGuard$, signal)) {
      return;
    }

    set(resetCustomConnectorProposalForm$);
    set(updatePage$, createElement(ZeroCustomConnectorProposalPage), "minimal");
    set(updateDocumentTitle$, "Configure custom connector");
    await set(hideAppSkeleton$, signal);
  },
);
