import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { navigate$, searchParams$ } from "../route.ts";
import { hasAnyModelProvider$ } from "../external/model-providers.ts";
import { throwIfAbort } from "../utils.ts";
import { ProviderSetupPage } from "../../views/provider-setup/provider-setup-page.tsx";

export const setupProviderSetupPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // If there's a return URL and user already has a provider, skip to return
    const returnUrl = get(searchParams$).get("return");
    if (returnUrl) {
      let hasProvider = false;
      try {
        hasProvider = await get(hasAnyModelProvider$);
      } catch (error) {
        throwIfAbort(error);
      }
      signal.throwIfAborted();

      if (hasProvider) {
        const url = new URL(returnUrl, location.origin);
        await set(
          navigate$,
          url.pathname,
          { searchParams: url.searchParams },
          signal,
        );
        signal.throwIfAborted();
        return;
      }
    }

    set(updatePage$, createElement(ProviderSetupPage));
  },
);
