import { command } from "ccstate";
import { createElement } from "react";
import { RedeemErrorPage } from "../../views/redeem-error-page/redeem-error-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

/**
 * Setup command for /redeem/error route.
 *
 * Renders a standalone error screen based on `?reason=`. No auth guard and no
 * MinimalSidebarLayout — redemptions can fail pre-auth (billing_unavailable)
 * so this page must be reachable by guests, and the sidebar chrome would
 * require pageSignal$ context we'd have no reason to wire up here.
 */
export const setupRedeemErrorPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(RedeemErrorPage));
    set(updateDocumentTitle$, "Redemption Error");
    await set(hideAppSkeleton$, signal);
  },
);
