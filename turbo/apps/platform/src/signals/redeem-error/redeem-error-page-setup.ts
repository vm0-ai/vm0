import { command } from "ccstate";
import { createElement } from "react";
import { MinimalSidebarLayout } from "../../views/zero-page/zero-directed-shared.tsx";
import { RedeemErrorPage } from "../../views/redeem-error-page/redeem-error-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";

/**
 * Setup command for /redeem/error route.
 *
 * Renders a human-readable error screen based on `?reason=`. No auth guard —
 * redemptions can fail at many points (including pre-auth billing_unavailable)
 * so this page is reachable by anyone who hit /redeem/[campaign].
 */
export const setupRedeemErrorPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(
      updatePage$,
      createElement(MinimalSidebarLayout, null, createElement(RedeemErrorPage)),
    );
    set(updateDocumentTitle$, "Redemption Error");
    await set(hideAppSkeleton$, signal);
  },
);
