import { command, computed, state } from "ccstate";
import {
  apiKeysContract,
  apiKeysByIdContract,
  type ApiKeyItem,
  type ApiKeyListResponse,
  type CreateApiKeyResponse,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReloadApiKeys$ = state(0);

export const apiKeys$ = computed(async (get) => {
  get(internalReloadApiKeys$);
  const createClient = get(zeroClient$);
  const client = createClient(apiKeysContract);
  const result = await accept(client.list(), [200], { toast: false });
  return result.body as ApiKeyListResponse;
});

const createApiKey$ = command(
  async (
    { get, set },
    input: { name: string; expiresInDays: number },
    signal: AbortSignal,
  ): Promise<CreateApiKeyResponse> => {
    const createClient = get(zeroClient$);
    const client = createClient(apiKeysContract);
    const result = await accept(
      client.create({ body: input, fetchOptions: { signal } }),
      [201],
    );
    signal.throwIfAborted();
    set(internalReloadApiKeys$, (x) => {
      return x + 1;
    });
    return result.body as CreateApiKeyResponse;
  },
);

const deleteApiKey$ = command(
  async ({ get, set }, id: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(apiKeysByIdContract);
    await accept(
      client.delete({ params: { id }, fetchOptions: { signal } }),
      [204],
    );
    signal.throwIfAborted();
    set(internalReloadApiKeys$, (x) => {
      return x + 1;
    });
  },
);

// ── UI state ─────────────────────────────────────────────────────────────

const DEFAULT_EXPIRY_DAYS = 90;

const internalCreateDialogOpen$ = state(false);
const internalFormName$ = state("");
const internalFormExpiry$ = state<number>(DEFAULT_EXPIRY_DAYS);
const internalRevealedToken$ = state<{
  token: string;
  name: string;
} | null>(null);
const internalRevokeTarget$ = state<ApiKeyItem | null>(null);
const internalPendingRevokeId$ = state<string | null>(null);

export const apiKeysCreateDialogOpen$ = computed((get) => {
  return get(internalCreateDialogOpen$);
});
export const apiKeysFormName$ = computed((get) => {
  return get(internalFormName$);
});
export const apiKeysFormExpiry$ = computed((get) => {
  return get(internalFormExpiry$);
});
export const apiKeysRevealedToken$ = computed((get) => {
  return get(internalRevealedToken$);
});
export const apiKeysRevokeTarget$ = computed((get) => {
  return get(internalRevokeTarget$);
});
export const apiKeysPendingRevokeId$ = computed((get) => {
  return get(internalPendingRevokeId$);
});

export const setApiKeyFormName$ = command(({ set }, value: string) => {
  set(internalFormName$, value);
});

export const setApiKeyFormExpiry$ = command(({ set }, value: number) => {
  set(internalFormExpiry$, value);
});

export const openCreateApiKeyDialog$ = command(({ set }) => {
  set(internalFormName$, "");
  set(internalFormExpiry$, DEFAULT_EXPIRY_DAYS);
  set(internalCreateDialogOpen$, true);
});

export const closeCreateApiKeyDialog$ = command(({ set }) => {
  set(internalCreateDialogOpen$, false);
});

export const submitCreateApiKey$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const name = get(internalFormName$).trim();
    const expiresInDays = get(internalFormExpiry$);
    if (!name) {
      return;
    }
    const result = await set(createApiKey$, { name, expiresInDays }, signal);
    set(internalCreateDialogOpen$, false);
    set(internalRevealedToken$, { token: result.token, name: result.name });
  },
);

export const closeRevealModal$ = command(({ set }) => {
  set(internalRevealedToken$, null);
});

export const openRevokeConfirm$ = command(({ set }, key: ApiKeyItem) => {
  set(internalRevokeTarget$, key);
});

export const closeRevokeConfirm$ = command(({ set }) => {
  set(internalRevokeTarget$, null);
});

export const confirmRevokeApiKey$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const target = get(internalRevokeTarget$);
    if (!target) {
      return;
    }
    set(internalPendingRevokeId$, target.id);
    await set(deleteApiKey$, target.id, signal).finally(() => {
      set(internalPendingRevokeId$, null);
    });
    signal.throwIfAborted();
    set(internalRevokeTarget$, null);
  },
);
