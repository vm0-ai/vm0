import { command } from "ccstate";
import { createElement } from "react";
import { RedeemStatusPage } from "../../views/redeem-status-page/redeem-status-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

/**
 * Setup command for /redeem/status route.
 *
 * Renders a standalone status screen for redemption success / processing
 * outcomes based on `?state=`. Mirrors the redeem-error page's no-sidebar
 * standalone layout so guest users arriving mid-flow still render cleanly.
 */
export const setupRedeemStatusPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(RedeemStatusPage));
    set(updateDocumentTitle$, "Redemption");
    await set(hideAppSkeleton$, signal);
  },
);
