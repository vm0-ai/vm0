import { command, computed, state } from "ccstate";
import {
  strapiIntegrationsContract,
  type StrapiIntegration,
  type StrapiIntegrationSecret,
} from "@okouai/api-contracts/contracts/strapi-integrations";
import { toast } from "@okouai/ui/components/ui/sonner";

import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";

const reload$ = state(0);
const name$ = state("");
const baseUrl$ = state("");
const revealedSecret$ = state<
  (StrapiIntegrationSecret & { readonly integrationId: string }) | null
>(null);

export const strapiIntegrations$ = computed(
  async (get): Promise<readonly StrapiIntegration[]> => {
    get(reload$);
    const client = get(apiClient$)(strapiIntegrationsContract);
    const result = await accept(client.list(), [200]);
    return result.body;
  },
);

export const strapiIntegrationForm$ = computed((get) => {
  return { name: get(name$), baseUrl: get(baseUrl$) };
});

export const strapiRevealedSecret$ = computed((get) => {
  return get(revealedSecret$);
});

export const updateStrapiIntegrationForm$ = command(
  ({ set }, patch: { readonly name?: string; readonly baseUrl?: string }) => {
    if (patch.name !== undefined) {
      set(name$, patch.name);
    }
    if (patch.baseUrl !== undefined) {
      set(baseUrl$, patch.baseUrl);
    }
  },
);

export const createStrapiIntegration$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const form = get(strapiIntegrationForm$);
    const client = get(apiClient$)(strapiIntegrationsContract);
    const result = await accept(
      client.create({ body: form, fetchOptions: { signal } }),
      [201],
    );
    signal.throwIfAborted();
    set(revealedSecret$, {
      integrationId: result.body.id,
      webhookUrl: result.body.webhookUrl,
      authorizationHeader: result.body.authorizationHeader,
    });
    set(name$, "");
    set(baseUrl$, "");
    set(reload$, (value) => {
      return value + 1;
    });
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.strapi.toasts.created;
      }),
    );
    return result.body;
  },
);

export const revealStrapiIntegrationSecret$ = command(
  async ({ get, set }, integrationId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(strapiIntegrationsContract);
    const result = await accept(
      client.revealSecret({
        params: { integrationId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(revealedSecret$, { integrationId, ...result.body });
    return result.body;
  },
);

export const checkStrapiIntegrationTest$ = command(
  async ({ get, set }, integrationId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(strapiIntegrationsContract);
    const result = await accept(
      client.checkTest({
        params: { integrationId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
    if (result.body.received) {
      toast.success(
        i18n.t(($) => {
          return $.connectors.providerSettings.strapi.toasts.testReceived;
        }),
      );
    } else {
      toast.info(
        i18n.t(($) => {
          return $.connectors.providerSettings.strapi.toasts.noTestReceived;
        }),
      );
    }
    return result.body;
  },
);

export const removeStrapiIntegration$ = command(
  async ({ get, set }, integrationId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(strapiIntegrationsContract);
    await accept(
      client.remove({
        params: { integrationId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    if (get(revealedSecret$)?.integrationId === integrationId) {
      set(revealedSecret$, null);
    }
    set(reload$, (value) => {
      return value + 1;
    });
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.strapi.toasts.removed;
      }),
    );
  },
);

export const resetStrapiSettings$ = command(({ set }) => {
  set(name$, "");
  set(baseUrl$, "");
  set(revealedSecret$, null);
});
