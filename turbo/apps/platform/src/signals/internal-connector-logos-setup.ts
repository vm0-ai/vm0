import { command, state, computed } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "./react-router.ts";

const ICON_SIZES = [16, 32, 48, 96, 128, 256] as const;
export type IconSize = (typeof ICON_SIZES)[number];

const internalIconSize$ = state<IconSize>(128);

export const iconSize$ = computed((get) => get(internalIconSize$));

export const iconSizes$ = computed(() => ICON_SIZES);

export const setIconSize$ = command(({ set }, size: IconSize) => {
  set(internalIconSize$, size);
});

export const setupInternalConnectorLogos$ = command(
  async ({ set }, _signal: AbortSignal) => {
    const { InternalConnectorLogos } = await import(
      "../views/internal-connector-logos.tsx"
    );
    set(updatePage$, createElement(InternalConnectorLogos));
  },
);
