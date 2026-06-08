import { command, computed, state } from "ccstate";

const ARTIFACT_DOWNLOAD_MENU_CLOSE_DELAY_MS = 80;

const internalArtifactDownloadMenuOpenKey$ = state<string | null>(null);
const internalArtifactDownloadMenuCloseToken$ = state(0);

export const artifactDownloadMenuOpenKey$ = computed((get) => {
  return get(internalArtifactDownloadMenuOpenKey$);
});

const closeArtifactDownloadMenuForToken$ = command(
  ({ get, set }, value: { key: string; token: number }) => {
    if (get(internalArtifactDownloadMenuCloseToken$) !== value.token) {
      return;
    }
    if (get(internalArtifactDownloadMenuOpenKey$) === value.key) {
      set(internalArtifactDownloadMenuOpenKey$, null);
    }
  },
);

export const openArtifactDownloadMenu$ = command(
  ({ set }, key: string | null) => {
    set(internalArtifactDownloadMenuCloseToken$, (value) => {
      return value + 1;
    });
    set(internalArtifactDownloadMenuOpenKey$, key);
  },
);

export const closeArtifactDownloadMenu$ = command(({ set }) => {
  set(internalArtifactDownloadMenuCloseToken$, (value) => {
    return value + 1;
  });
  set(internalArtifactDownloadMenuOpenKey$, null);
});

export const scheduleArtifactDownloadMenuClose$ = command(
  ({ get, set }, key: string) => {
    const token = get(internalArtifactDownloadMenuCloseToken$) + 1;
    set(internalArtifactDownloadMenuCloseToken$, token);
    window.setTimeout(() => {
      set(closeArtifactDownloadMenuForToken$, { key, token });
    }, ARTIFACT_DOWNLOAD_MENU_CLOSE_DELAY_MS);
  },
);
