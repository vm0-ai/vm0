import { command, computed, state } from "ccstate";

const internalPresentationHtmlRefreshVersion$ = state(0);

export const presentationHtmlRefreshVersion$ = computed((get) => {
  return get(internalPresentationHtmlRefreshVersion$);
});

export const refreshPresentationHtmlPreviews$ = command(({ set }) => {
  set(internalPresentationHtmlRefreshVersion$, (version) => {
    return version + 1;
  });
});

export function presentationHtmlPreviewUrl(
  url: string,
  version: number,
): string {
  if (version === 0 || !URL.canParse(url)) {
    return url;
  }
  const parsed = new URL(url);
  parsed.searchParams.set("_vm0_presentation_version", String(version));
  return parsed.toString();
}
