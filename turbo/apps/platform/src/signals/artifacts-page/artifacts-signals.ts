import { command, computed, state } from "ccstate";
import {
  artifactsContract,
  type ArtifactsListQuery,
  type ArtifactsListResponse,
} from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";

const internalArtifactsSearch$ = state("");
const internalArtifactsAgentId$ = state<string | null>(null);
const internalArtifactsReload$ = state(0);

export const artifactsSearch$ = computed((get) => {
  return get(internalArtifactsSearch$);
});

export const selectedArtifactsAgentId$ = computed((get) => {
  return get(internalArtifactsAgentId$);
});

export const setArtifactsSearch$ = command(({ set }, search: string) => {
  set(internalArtifactsSearch$, search);
});

export const setSelectedArtifactsAgentId$ = command(
  ({ set }, agentId: string | null) => {
    set(internalArtifactsAgentId$, agentId);
  },
);

export const resetArtifactsFilters$ = command(({ set }) => {
  set(internalArtifactsSearch$, "");
  set(internalArtifactsAgentId$, null);
});

export const reloadArtifacts$ = command(({ set }) => {
  set(internalArtifactsReload$, (version) => {
    return version + 1;
  });
});

export const artifactsList$ = computed(
  async (get): Promise<ArtifactsListResponse> => {
    get(internalArtifactsReload$);
    const search = get(artifactsSearch$).trim();
    const agentId = get(selectedArtifactsAgentId$);
    const query: ArtifactsListQuery = {
      limit: 50,
      ...(search ? { query: search } : {}),
      ...(agentId ? { agentId } : {}),
    };
    const client = get(zeroClient$)(artifactsContract);
    const result = await accept(client.list({ query }), [200], {
      toast: false,
    });
    return result.body;
  },
);

export const navigateToArtifactThread$ = command(
  ({ set }, threadId: string) => {
    set(detachedNavigateTo$, ROUTES.chat, {
      pathParams: { threadId },
    });
  },
);
