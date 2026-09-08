/**
 * Shared Base UI popup motion.
 *
 * Dialogs use Base UI's `data-open` / `data-closed` CSS animation contract so
 * they animate when their Root is mounted already open. Other popups use
 * cancellable `data-starting-style` / `data-ending-style` transitions. Keep
 * opacity in every recipe so Base UI observes the visual completion boundary.
 */
export const dialogBackdropAnimationClassName =
  "data-open:animate-[okou-dialog-backdrop-in_150ms_ease-out] data-closed:animate-[okou-dialog-backdrop-out_150ms_ease-out] motion-reduce:animate-none";

export const dialogPopupAnimationClassName =
  "data-open:animate-[okou-dialog-popup-in_150ms_ease-out] data-closed:animate-[okou-dialog-popup-out_150ms_ease-out] motion-reduce:animate-none";

export const modalBackdropTransitionClassName =
  "transition-opacity duration-150 ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none";

export const anchoredPopupTransitionClassName =
  "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 ease-out data-starting-style:opacity-0 data-starting-style:[transform:scale(0.98)] data-ending-style:opacity-0 data-ending-style:[transform:scale(0.98)] motion-reduce:transition-none";

export const sheetPopupTransitionClassName =
  "transition-[translate,opacity] duration-150 ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none";
