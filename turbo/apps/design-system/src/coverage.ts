/**
 * The sync mechanism.
 *
 * The catalogue is only useful if it is complete, and completeness cannot be
 * maintained by remembering to update it. `undocumented()` compares the real
 * component surface against the demos, and the test beside it fails when the
 * two diverge — so adding a component to `@okouai/ui` fails CI until the
 * catalogue covers it.
 */

import { DEMOS } from "./demos";
import { components } from "./manifest";

/** Components that ship in `@okouai/ui` but have no demo in the catalogue. */
export function undocumented(): string[] {
  const covered = new Set(
    DEMOS.map((demo) => {
      return demo.id;
    }),
  );
  return components.components
    .map((entry) => {
      return entry.id;
    })
    .filter((id) => {
      return !covered.has(id);
    })
    .sort();
}

/** Demos that no longer match a component file — a rename or a deletion. */
export function orphaned(): string[] {
  const shipped = new Set(
    components.components.map((entry) => {
      return entry.id;
    }),
  );
  return DEMOS.map((demo) => {
    return demo.id;
  })
    .filter((id) => {
      return !shipped.has(id);
    })
    .sort();
}
