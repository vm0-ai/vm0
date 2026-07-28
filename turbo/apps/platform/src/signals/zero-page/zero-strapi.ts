import { command, computed, state } from "ccstate";
import {
  zeroStrapiIntegrationsContract,
  type StrapiIntegration,
  type StrapiIntegrationSecret,
} from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import { toast } from "@vm0/ui/components/ui/sonner";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

const reload$ = state(0);
const name$ = state("");
const baseUrl$ = state("");
const revealedSecret$ = state<
  (StrapiIntegrationSecret & { readonly integrationId: string }) | null
>(null);

export const strapiIntegrations$ = computed(
  async (get): Promise<readonly StrapiIntegration[]> => {
    get(reload$);
    const client = get(zeroClient$)(zeroStrapiIntegrationsContract);
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
    const client = get(zeroClient$)(zeroStrapiIntegrationsContract);
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
    toast.success("Strapi integration created");
    return result.body;
  },
);

export const revealStrapiIntegrationSecret$ = command(
  async ({ get, set }, integrationId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroStrapiIntegrationsContract);
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
    const client = get(zeroClient$)(zeroStrapiIntegrationsContract);
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
      toast.success("Strapi test webhook received");
    } else {
      toast.info("No Strapi test webhook received yet");
    }
    return result.body;
  },
);

export const removeStrapiIntegration$ = command(
  async ({ get, set }, integrationId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroStrapiIntegrationsContract);
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
    toast.success("Strapi integration removed");
  },
);

export const resetStrapiSettings$ = command(({ set }) => {
  set(name$, "");
  set(baseUrl$, "");
  set(revealedSecret$, null);
});
