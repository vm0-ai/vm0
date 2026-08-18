import { posix } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES,
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES,
  MAX_PRESENTATION_TEMPLATE_PACKAGE_TOTAL_BYTES,
} from "@okouai/api-contracts/contracts/zero-presentation-templates";
import { Parser } from "tar";

import { createDeferredPromise, safeSync } from "../utils";

const MAX_PACKAGE_PATH_BYTES = 1024;
const MAX_TAR_BYTES =
  MAX_PRESENTATION_TEMPLATE_PACKAGE_TOTAL_BYTES +
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES * (MAX_PACKAGE_PATH_BYTES + 2048) +
  1024;
const REQUIRED_PACKAGE_PATHS = ["SKILL.md", "design-system.md"] as const;
const ASSET_PATH_PREFIXES = [
  "assets/identity/",
  "assets/backgrounds/",
  "assets/fonts/",
] as const;
const OPTIONAL_DIRECTORY_PATHS = [
  "color-systems",
  "assets",
  "assets/identity",
  "assets/backgrounds",
  "assets/fonts",
] as const;

export interface PresentationTemplatePackageFile {
  readonly path: string;
  readonly content: Buffer;
}

type PresentationTemplatePackageArchiveResult =
  | {
      readonly ok: true;
      readonly files: readonly PresentationTemplatePackageFile[];
    }
  | { readonly ok: false; readonly message: string };

function invalid(message: string): PresentationTemplatePackageArchiveResult {
  return { ok: false, message };
}

function pathValidationError(path: string): string | null {
  const pathBytes = new TextEncoder().encode(path).byteLength;
  const parts = path.split("/");
  if (
    path.length === 0 ||
    pathBytes > MAX_PACKAGE_PATH_BYTES ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.normalize(path) !== path ||
    parts.some((part) => {
      return part.length === 0 || part === "." || part === "..";
    })
  ) {
    return `Template package contains an unsafe path: ${path}`;
  }
  return null;
}

function filePathValidationError(path: string): string | null {
  const unsafe = pathValidationError(path);
  if (unsafe) {
    return unsafe;
  }
  if (path.toLowerCase().endsWith(".json")) {
    return "Template packages must not contain JSON files";
  }
  if (
    REQUIRED_PACKAGE_PATHS.some((required) => {
      return required === path;
    })
  ) {
    return null;
  }
  if (/^color-systems\/[^/]+\.css$/u.test(path)) {
    return null;
  }
  if (
    ASSET_PATH_PREFIXES.some((prefix) => {
      return path.startsWith(prefix) && path.length > prefix.length;
    })
  ) {
    return null;
  }
  return `Template package path is outside the supported package structure: ${path}`;
}

function directoryPathValidationError(path: string): string | null {
  const unsafe = pathValidationError(path);
  if (unsafe) {
    return unsafe;
  }
  if (
    OPTIONAL_DIRECTORY_PATHS.some((directory) => {
      return path === directory || path.startsWith(`${directory}/`);
    })
  ) {
    return null;
  }
  return `Template package directory is outside the supported package structure: ${path}`;
}

function textFileValidationError(path: string, content: Buffer): string | null {
  if (!path.endsWith(".md") && !path.endsWith(".css")) {
    return null;
  }
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  });
  if ("error" in decoded) {
    return `Template package text file is not valid UTF-8: ${path}`;
  }
  return decoded.ok.trim().length === 0
    ? `Template package file must not be empty: ${path}`
    : null;
}

function packageCompletionError(
  files: readonly PresentationTemplatePackageFile[],
  directories: ReadonlySet<string>,
): string | null {
  const paths = new Set(
    files.map((file) => {
      return file.path;
    }),
  );
  const missing = REQUIRED_PACKAGE_PATHS.find((path) => {
    return !paths.has(path);
  });
  if (missing) {
    return `Template package is missing required file: ${missing}`;
  }
  const emptyDirectory = [...directories].find((directory) => {
    return !files.some((file) => {
      return file.path.startsWith(`${directory}/`);
    });
  });
  return emptyDirectory
    ? `Template package contains an empty directory: ${emptyDirectory}`
    : null;
}

function parsePackageTar(
  tarBuffer: Buffer,
  signal: AbortSignal,
): Promise<PresentationTemplatePackageArchiveResult> {
  const deferred =
    createDeferredPromise<PresentationTemplatePackageArchiveResult>(signal);
  const files: PresentationTemplatePackageFile[] = [];
  const paths = new Set<string>();
  const directories = new Set<string>();
  let totalSize = 0;
  let failure: string | null = null;
  const fail = (message: string): void => {
    failure ??= message;
  };

  const parser = new Parser({
    preservePaths: true,
    strict: true,
    onReadEntry: (entry) => {
      if (entry.type === "Directory") {
        const path = entry.path.replace(/\/$/u, "");
        const error = directoryPathValidationError(path);
        if (error) {
          fail(error);
        } else {
          directories.add(path);
        }
        entry.resume();
        return;
      }
      if (entry.type !== "File") {
        fail(`Template package contains unsupported entry type: ${entry.type}`);
        entry.resume();
        return;
      }

      const path = entry.path;
      const pathError = filePathValidationError(path);
      if (pathError) {
        fail(pathError);
      }
      if (paths.has(path)) {
        fail(`Template package contains duplicate path: ${path}`);
      }
      paths.add(path);
      if (paths.size > MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES) {
        fail(
          `Template package may contain at most ${MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES.toString()} files`,
        );
      }
      if (
        entry.size <= 0 ||
        entry.size > MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES
      ) {
        fail(
          `Template package file must be non-empty and no larger than ${MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES.toString()} bytes: ${path}`,
        );
      }
      totalSize += entry.size;
      if (totalSize > MAX_PRESENTATION_TEMPLATE_PACKAGE_TOTAL_BYTES) {
        fail(
          `Template package may contain at most ${MAX_PRESENTATION_TEMPLATE_PACKAGE_TOTAL_BYTES.toString()} bytes`,
        );
      }

      const chunks: Buffer[] = [];
      let receivedSize = 0;
      entry.on("data", (chunk: Buffer) => {
        receivedSize += chunk.length;
        chunks.push(Buffer.from(chunk));
      });
      entry.on("end", () => {
        if (receivedSize !== entry.size) {
          fail(`Template package file is incomplete: ${path}`);
          return;
        }
        const content = Buffer.concat(chunks, receivedSize);
        const textError = textFileValidationError(path, content);
        if (textError) {
          fail(textError);
          return;
        }
        files.push({ path, content });
      });
    },
  });

  parser.on("end", () => {
    if (deferred.settled()) {
      return;
    }
    const completionError = packageCompletionError(files, directories);
    deferred.resolve(
      failure || completionError
        ? invalid(failure ?? completionError ?? "Invalid template package")
        : { ok: true, files },
    );
  });
  parser.on("error", () => {
    if (!deferred.settled()) {
      deferred.resolve(invalid("Template package is not a valid tar archive"));
    }
  });
  const parsed = safeSync(() => {
    parser.end(tarBuffer);
  });
  if ("error" in parsed && !deferred.settled()) {
    deferred.resolve(invalid("Template package is not a valid tar archive"));
  }
  return deferred.promise;
}

export async function validatePresentationTemplatePackageArchive(
  archive: Buffer,
  signal: AbortSignal,
): Promise<PresentationTemplatePackageArchiveResult> {
  const decompressed = safeSync(() => {
    return gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES });
  });
  if ("error" in decompressed) {
    return invalid("Template package is not a valid bounded tar.gz archive");
  }
  signal.throwIfAborted();
  return await parsePackageTar(decompressed.ok, signal);
}
