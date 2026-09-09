import {
  introVideoPresenterContract,
  type IntroVideoStyle,
  type IntroVideoStylesResponse,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { command, computed, state } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { pageSignal$ } from "../page-signal.ts";
import { onRef } from "../utils.ts";

function createIntroVideoStyleGallerySignals() {
  const internalReload$ = state(0);
  const internalPreviewId$ = state<string | null>(null);
  return {
    catalog$: computed(async (get) => {
      get(internalReload$);
      const signal = get(pageSignal$);
      const client = get(apiClient$)(introVideoPresenterContract, {
        apiBase: "api",
      });
      const styles: IntroVideoStyle[] = [];
      const requestedTokens = new Set<string>();
      let token: string | null = null;
      // Complete the catalog before grouping so counts and section positions stay stable.
      do {
        const result: { body: IntroVideoStylesResponse } = await accept(
          client.styles({
            query: {
              pageSize: 100,
              ...(token === null ? {} : { token }),
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        styles.push(...result.body.styles);
        token = result.body.hasMore ? result.body.nextToken : null;
        if (token !== null) {
          if (requestedTokens.has(token)) {
            throw new Error(
              "The style catalog returned a repeated pagination token",
            );
          }
          requestedTokens.add(token);
        }
      } while (token !== null);
      return styles.filter((style) => {
        return style.aspectRatio !== "9:16";
      });
    }),
    reload$: command(({ set }) => {
      set(internalReload$, (revision) => {
        return revision + 1;
      });
    }),
    setGalleryRef$: onRef<HTMLDivElement>(
      command(({ set }, _node: HTMLDivElement, signal: AbortSignal) => {
        signal.addEventListener(
          "abort",
          () => {
            set(internalPreviewId$, null);
          },
          { once: true },
        );
      }),
    ),
    previewId$: computed((get) => {
      return get(internalPreviewId$);
    }),
    previewStyle$: command(({ set }, id: string) => {
      set(internalPreviewId$, id);
    }),
  };
}

export const introVideoStyleGallerySignals =
  createIntroVideoStyleGallerySignals();
