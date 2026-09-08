/**
 * Shared Base UI popup transitions.
 *
 * Base UI keeps popup elements mounted until transitions registered through
 * `data-starting-style` and `data-ending-style` finish. Keep opacity in every
 * recipe so both the visual fade and the unmount boundary use the same motion.
 */
export const modalBackdropTransitionClassName =
  "transition-opacity duration-150 ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none";

export const dialogPopupTransitionClassName =
  "transition-[transform,opacity] duration-150 ease-out data-starting-style:opacity-0 data-starting-style:[transform:translateY(8px)] data-ending-style:opacity-0 data-ending-style:[transform:translateY(8px)] motion-reduce:transition-none";

export const anchoredPopupTransitionClassName =
  "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 ease-out data-starting-style:opacity-0 data-starting-style:[transform:scale(0.98)] data-ending-style:opacity-0 data-ending-style:[transform:scale(0.98)] motion-reduce:transition-none";

export const sheetPopupTransitionClassName =
  "transition-[translate,opacity] duration-150 ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none";
