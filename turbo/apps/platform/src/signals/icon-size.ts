import { command, state, computed } from "ccstate";

const ICON_SIZES = [16, 32, 48, 96, 128, 256] as const;
export type IconSize = (typeof ICON_SIZES)[number];

const internalIconSize$ = state<IconSize>(128);

export const iconSize$ = computed((get) => {
  return get(internalIconSize$);
});

export const iconSizes$ = computed(() => {
  return ICON_SIZES;
});

export const setIconSize$ = command(({ set }, size: IconSize) => {
  set(internalIconSize$, size);
});
