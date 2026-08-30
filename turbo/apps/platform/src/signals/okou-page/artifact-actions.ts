import { command, computed, state } from "ccstate";

const internalArtifactDownloadMenuOpenKey$ = state<string | null>(null);
const internalArtifactDownloadPendingKey$ = state<string | null>(null);

export const artifactDownloadMenuOpenKey$ = computed((get) => {
  return get(internalArtifactDownloadMenuOpenKey$);
});

export const artifactDownloadPendingKey$ = computed((get) => {
  return get(internalArtifactDownloadPendingKey$);
});

export const openArtifactDownloadMenu$ = command(
  ({ set }, key: string | null) => {
    set(internalArtifactDownloadMenuOpenKey$, key);
  },
);

export const closeArtifactDownloadMenu$ = command(({ set }) => {
  set(internalArtifactDownloadMenuOpenKey$, null);
});

export const startArtifactDownload$ = command(({ set }, key: string) => {
  set(internalArtifactDownloadPendingKey$, key);
});

export const finishArtifactDownload$ = command(({ get, set }, key: string) => {
  if (get(internalArtifactDownloadPendingKey$) === key) {
    set(internalArtifactDownloadPendingKey$, null);
  }
});
