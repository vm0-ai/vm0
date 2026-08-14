/**
 * Gallery tile shared by every template picker category (video, website,
 * workflow, presentation, avatar). Hover feedback comes from the scrim and the
 * Use pill alone — the card already carries a hairline border, so a hover ring
 * only doubled it. The ring is reserved for the selected state, offset so it
 * is drawn outside the card and keeps a gap from the artwork.
 */
export const TEMPLATE_TILE_WRAPPER = "group/tile relative cursor-pointer";
export const TEMPLATE_TILE_RING =
  "rounded-xl ring-offset-1 ring-offset-card transition-shadow duration-150";
export const TEMPLATE_TILE_RING_SELECTED = "ring-1 ring-primary";
export const TEMPLATE_TILE_MEDIA =
  "relative overflow-hidden border border-gray-200 bg-muted";
export const TEMPLATE_TILE_SCRIM =
  "pointer-events-none absolute inset-x-0 bottom-0 z-[15] h-14 bg-gradient-to-t from-black/45 to-transparent opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100";
export const TEMPLATE_TILE_USE =
  "absolute bottom-2 right-2 z-20 h-[30px] rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground opacity-100 transition-opacity duration-150 hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-hover/tile:opacity-100";
// Caption metrics track the illustration card: same text size, and enough
// breathing room under the artwork that the title never crowds it.
export const TEMPLATE_TILE_CAPTION = "flex items-baseline gap-2 px-2 pb-2 pt-2";
export const TEMPLATE_TILE_NAME =
  "min-w-0 truncate text-sm font-medium leading-5 text-foreground";
