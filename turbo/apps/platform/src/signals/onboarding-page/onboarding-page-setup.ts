import { command } from "ccstate";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { createElement } from "react";
import { OnboardingPage } from "../../views/onboarding-page/onboarding-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import {
  detachedNavigateTo$,
  replaceSearchParams$,
  searchParams$,
} from "../route.ts";
import {
  resetOnboardingStep$,
  toggleZeroConnector$,
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
  zeroSelectedConnectors$,
} from "../zero-page/zero-onboarding.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
export const setupOnboardingPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(OnboardingPage));
    set(updateDocumentTitle$, "Onboarding");
    await set(hideAppSkeleton$, signal);

    set(resetOnboardingStep$);
    signal.throwIfAborted();

    // If onboarding is not needed, redirect to home
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const needsMemberOnboarding = await get(zeroNeedsMemberOnboarding$);
    signal.throwIfAborted();

    if (!needsOnboarding && !needsMemberOnboarding) {
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    // Consume ?connector= (comma-separated) to pre-select connectors, then
    // strip the param from the URL. Keep ?prompt= intact so it survives
    // through to the chat composer after onboarding completes.
    const params = get(searchParams$);
    const connectorParam = params.get("connector");
    if (connectorParam !== null) {
      const isConnectorType = (id: string): id is ConnectorType => {
        return id in CONNECTOR_TYPES;
      };
      const alreadySelected = new Set<ConnectorType>(
        get(zeroSelectedConnectors$),
      );
      const connectorIds = connectorParam
        .split(",")
        .map((id) => {
          return id.trim();
        })
        .filter(isConnectorType);
      const unique = Array.from(new Set(connectorIds));
      for (const id of unique) {
        if (!alreadySelected.has(id)) {
          set(toggleZeroConnector$, id);
          alreadySelected.add(id);
        }
      }
      const next = new URLSearchParams(params);
      next.delete("connector");
      set(replaceSearchParams$, next);
    }
  },
);
