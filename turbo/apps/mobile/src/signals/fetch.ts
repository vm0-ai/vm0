import { computed } from "ccstate";

/**
 * Raw fetch signal — only for use by api-client.ts and auth layers.
 * Views and page signals must use zeroClient$ instead.
 */
export const fetch$ = computed(() => {
  return fetch;
});

export const apiBase$ = computed(() => {
  return Promise.resolve(
    process.env.EXPO_PUBLIC_API_URL ?? "https://api.vm0.ai",
  );
});
