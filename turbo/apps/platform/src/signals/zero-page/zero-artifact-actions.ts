import { command, computed, state } from "ccstate";

const internalArtifactDownloadMenuOpenKey$ = state<string | null>(null);

export const artifactDownloadMenuOpenKey$ = computed((get) => {
  return get(internalArtifactDownloadMenuOpenKey$);
});

export const openArtifactDownloadMenu$ = command(
  ({ set }, key: string | null) => {
    set(internalArtifactDownloadMenuOpenKey$, key);
  },
);

export const closeArtifactDownloadMenu$ = command(({ set }) => {
  set(internalArtifactDownloadMenuOpenKey$, null);
});
