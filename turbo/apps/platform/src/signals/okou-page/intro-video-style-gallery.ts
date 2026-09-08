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
  const internalActiveGroup$ = state<string | null>(null);
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
    previewId$: computed((get) => {
      return get(internalPreviewId$);
    }),
    previewStyle$: command(({ set }, id: string) => {
      set(internalPreviewId$, id);
    }),
    activeGroup$: computed((get) => {
      return get(internalActiveGroup$);
    }),
    setGalleryRef$: onRef<HTMLDivElement>(
      command(({ set }, node: HTMLDivElement, signal: AbortSignal) => {
        const scroll = node.closest<HTMLElement>(
          "[data-intro-video-catalog-scroll]",
        );
        if (!scroll) {
          throw new Error(
            "The intro video style gallery must render inside the catalog scroll container",
          );
        }
        const sections = [
          ...node.querySelectorAll<HTMLElement>(
            "[data-intro-video-style-group]",
          ),
        ];
        const syncActiveGroup = () => {
          // The active group is the last heading that has reached the top edge.
          // The tolerance covers the scroll padding an anchored jump leaves.
          const edge = scroll.getBoundingClientRect().top + 32;
          const reached = sections.filter((section) => {
            return section.getBoundingClientRect().top <= edge;
          });
          // Overscrolling above the first heading keeps the first group active.
          const active = reached.at(-1) ?? sections.at(0);
          set(
            internalActiveGroup$,
            active?.dataset.introVideoStyleGroup ?? null,
          );
        };
        scroll.addEventListener("scroll", syncActiveGroup, {
          passive: true,
          signal,
        });
        syncActiveGroup();
        signal.addEventListener(
          "abort",
          () => {
            set(internalPreviewId$, null);
            set(internalActiveGroup$, null);
          },
          { once: true },
        );
      }),
    ),
  };
}

export const introVideoStyleGallerySignals =
  createIntroVideoStyleGallerySignals();
