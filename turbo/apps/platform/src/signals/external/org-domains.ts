import { command, computed, state } from "ccstate";
import { zeroOrgDomainsContract } from "@vm0/core";
import { org$ } from "../org";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { throwIfAbort } from "../utils.ts";

const domainsVersion$ = state(0);

export const refreshOrgDomains$ = command(({ get, set }) => {
  set(domainsVersion$, get(domainsVersion$) + 1);
});

const domainsResponse$ = computed(async (get) => {
  get(domainsVersion$);
  const org = await get(org$);
  if (!org) {
    return null;
  }

  const createClient = get(zeroClient$);
  const client = createClient(zeroOrgDomainsContract);
  // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove — use accept() error propagation
  try {
    const result = await accept(client.list(), [200], { toast: false });
    return result.body;
  } catch (error) {
    throwIfAbort(error);
    return null;
  }
});

export const orgDomains$ = computed(async (get) => {
  const response = await get(domainsResponse$);
  return response?.domains ?? [];
});
