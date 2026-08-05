import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the platform's global stylesheet as text. Tests run in happy-dom, which
 * applies no CSS and performs no layout, so a rule can only be asserted from its
 * own source. The path depends on whether vitest was started from the workspace
 * or from the turbo root.
 */
export function readGlobalCss(): string {
  const candidates = [
    join(process.cwd(), "src/views/css/index.css"),
    join(process.cwd(), "apps/platform/src/views/css/index.css"),
  ];
  const path = candidates.find((candidate) => {
    return existsSync(candidate);
  });
  if (path === undefined) {
    throw new Error("Unable to locate platform global CSS");
  }
  return readFileSync(path, "utf8");
}

/** Returns the declarations of the rule introduced by `selector`. */
export function readCssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`Unable to locate CSS rule for ${selector}`);
  }
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}
