import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Every native helper executable ships from this one SwiftPM package, so only
 * the binary name differs between them.
 */
const NATIVE_PACKAGE_DIR = "computer-use-helper";

export interface ResolveNativeHelperPathOptions {
  readonly appRoot?: string;
  readonly resourcesPath?: string;
  readonly exists?: (candidate: string) => boolean;
}

function helperPathCandidates(
  helperName: string,
  options: ResolveNativeHelperPathOptions,
): readonly [string, string, string] {
  const appRoot = options.appRoot ?? path.resolve(__dirname, "..");
  const resourcesPath =
    options.resourcesPath ?? process.resourcesPath ?? appRoot;
  return [
    path.join(resourcesPath, "native", helperName),
    path.join(appRoot, "native", "dist", "native", helperName),
    path.join(
      appRoot,
      "native",
      NATIVE_PACKAGE_DIR,
      ".build",
      "release",
      helperName,
    ),
  ];
}

/**
 * Resolves a native helper executable across the packaged app, the packaging
 * staging directory, and a local `swift build` output, in that order.
 *
 * When none exists the packaging staging path is returned so the spawn failure
 * names the location the build is expected to produce.
 */
export function resolveNativeHelperPath(
  helperName: string,
  options: ResolveNativeHelperPathOptions = {},
): string {
  const exists = options.exists ?? existsSync;
  const candidates = helperPathCandidates(helperName, options);
  const existing = candidates.find((candidate) => {
    return exists(candidate);
  });
  return existing ?? candidates[1];
}
