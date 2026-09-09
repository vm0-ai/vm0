/** Content-free diagnostics carried by the existing terminal error string. */
const STAGES = ["output_validation", "mounted_apply", "unknown"] as const;
const REASONS = [
  "unknown",
  "filesystem",
  "unsafe_path",
  "unsafe_tree",
  "file_size",
  "inventory_files",
  "inventory_paths",
  "inventory_bytes",
  "file_integrity",
  "base_mismatch",
  "final_identity",
  "immutable_changed",
  "required_artifact",
  "memory_invalid",
  "memory_bytes",
  "summary_encoding",
  "summary_header",
  "summary_bytes",
  "summary_tokens",
  "skill_path",
  "skill_encoding",
  "skill_file_bytes",
  "skill_files",
  "skill_bytes",
  "skill_manifest",
] as const;
const FILE_CLASSES = [
  "memory",
  "summary",
  "skill",
  "git",
  "immutable",
  "tree",
  "unknown",
] as const;
const ERRNOS = [
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EROFS",
  "ENOENT",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EISDIR",
  "ENOTDIR",
  "ELOOP",
  "unknown",
] as const;
const MAX_COUNT = 2_147_483_647;

export interface PiMemoryPhase2Diagnostic {
  readonly stage: (typeof STAGES)[number];
  readonly reason: (typeof REASONS)[number];
  readonly fileClass?: (typeof FILE_CLASSES)[number];
  readonly errno?: (typeof ERRNOS)[number];
  readonly actual?: number;
  readonly limit?: number;
}

function allowed<T extends string>(
  values: readonly T[],
  value: unknown,
): T | undefined {
  return values.find((candidate) => {
    return candidate === value;
  });
}

function boundedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_COUNT)
    : undefined;
}

/** Re-project at the log boundary; never serialize arbitrary properties or text. */
export function sanitizePiMemoryPhase2Diagnostic(
  value: unknown,
): PiMemoryPhase2Diagnostic {
  try {
    const fields =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const fileClass =
      fields.fileClass === undefined
        ? undefined
        : (allowed(FILE_CLASSES, fields.fileClass) ?? "unknown");
    const errno =
      fields.errno === undefined
        ? undefined
        : (allowed(ERRNOS, fields.errno) ?? "unknown");
    const actual = boundedCount(fields.actual);
    const limit = boundedCount(fields.limit);
    return Object.freeze({
      stage: allowed(STAGES, fields.stage) ?? "unknown",
      reason: allowed(REASONS, fields.reason) ?? "unknown",
      ...(fileClass === undefined ? {} : { fileClass }),
      ...(errno === undefined ? {} : { errno }),
      ...(actual === undefined ? {} : { actual }),
      ...(limit === undefined ? {} : { limit }),
    });
  } catch {
    // A hostile diagnostic accessor must not replace the primary failure.
    return Object.freeze({ stage: "unknown", reason: "unknown" });
  }
}

export function phase2FileClass(
  path: string,
): NonNullable<PiMemoryPhase2Diagnostic["fileClass"]> {
  if (path === "MEMORY.md") return "memory";
  if (path === "memory_summary.md") return "summary";
  if (path.startsWith("skills/")) return "skill";
  if (path === ".git" || path.startsWith(".git/")) return "git";
  return path === "" ? "tree" : "immutable";
}

export class Phase2OutputInvalidError extends Error {
  readonly diagnostic: PiMemoryPhase2Diagnostic;

  constructor(
    reason: PiMemoryPhase2Diagnostic["reason"] = "unknown",
    details: Omit<PiMemoryPhase2Diagnostic, "stage" | "reason"> = {},
    stage: PiMemoryPhase2Diagnostic["stage"] = "output_validation",
  ) {
    super("Pi memory Phase 2 agent output was invalid.");
    this.diagnostic = sanitizePiMemoryPhase2Diagnostic({
      ...details,
      stage,
      reason,
    });
  }
}

export function phase2DiagnosticForError(
  error: unknown,
  stage: PiMemoryPhase2Diagnostic["stage"],
  fileClass: PiMemoryPhase2Diagnostic["fileClass"] = "tree",
): PiMemoryPhase2Diagnostic {
  if (error instanceof Phase2OutputInvalidError) {
    return sanitizePiMemoryPhase2Diagnostic({ ...error.diagnostic, stage });
  }
  // Read only a data property: raw text and arbitrary getters stay outside
  // this best-effort diagnostic boundary.
  let errno: PiMemoryPhase2Diagnostic["errno"];
  try {
    const value: unknown =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
    errno = allowed(ERRNOS, value);
  } catch {
    errno = undefined;
  }
  return sanitizePiMemoryPhase2Diagnostic({
    stage,
    reason: errno && errno !== "unknown" ? "filesystem" : "unknown",
    fileClass,
    errno: errno ?? "unknown",
  });
}
