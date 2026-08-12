/**
 * Which half of a video template chip the user clicked.
 *
 * Choosing the model and tuning the parameters it accepts are two separate
 * decisions, so each has its own zone on the chip and its own popover. Keeping
 * the union here lets the chip node view name a pane without importing the
 * composer signals it lives under.
 */
export type VideoTemplateOptionsPane = "model" | "settings";

export function parseVideoTemplateOptionsPane(
  value: string | undefined,
): VideoTemplateOptionsPane | undefined {
  return value === "model" || value === "settings" ? value : undefined;
}
