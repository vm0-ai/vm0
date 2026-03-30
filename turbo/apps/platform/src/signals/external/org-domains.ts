import { command, computed, state } from "ccstate";
import { zeroOrgDomainsContract } from "@vm0/core";
import { org$ } from "../org";
import { zeroClient$ } from "../api-client";

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
  const result = await client.list();

  if (result.status === 200) {
    return result.body;
  }
  return null;
});

export const orgDomains$ = computed(async (get) => {
  const response = await get(domainsResponse$);
  return response?.domains ?? [];
});
