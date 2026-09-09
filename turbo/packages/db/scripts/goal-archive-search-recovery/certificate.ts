// Temporary #32875 execution boundary. Remove in S3/S4 before S5 drops receipts.
export const expectedCount = 4162;
export const expectedHash =
  "aa033d67b27ff3fdbd30c945e482962b3e054cf4a1a4f74fce7edf74fed4e7f2";

export type Mode = "dry-run" | "apply";
type Phase =
  | "before"
  | "preflight"
  | "before-apply"
  | "apply"
  | "verify"
  | "after";

export class CertificateError extends Error {
  constructor(
    readonly errorClass:
      | "invalid_mode"
      | "invalid_cohort"
      | "cohort_mismatch"
      | "invalid_report"
      | "incomplete_report"
      | "disallowed_outcome"
      | "operation_failed",
  ) {
    super(errorClass);
  }
}

export function parseMode(args: readonly string[]): Mode {
  if (args.length === 0) return "dry-run";
  if (args.length === 1 && (args[0] === "dry-run" || args[0] === "apply"))
    return args[0];
  throw new CertificateError("invalid_mode");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CertificateError("invalid_report");
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new CertificateError("invalid_report");
  return value;
}

const cohortKeys = [
  "goals",
  "threads",
  "receipts",
  "active",
  "complete",
  "paused",
  "blocked",
  "nonterminal",
  "pending",
] as const;

function decodeCohort(value: unknown) {
  const raw = object(value);
  const counts: Record<string, number> = {};
  for (const key of cohortKeys) {
    const field = raw[key];
    if (typeof field !== "string" || !/^(0|[1-9][0-9]*)$/u.test(field))
      throw new CertificateError("invalid_cohort");
    counts[key] = count(Number(field));
  }
  if (typeof raw.hash !== "string" || !/^[0-9a-f]{64}$/u.test(raw.hash))
    throw new CertificateError("invalid_cohort");
  return { counts, hash: raw.hash };
}

const outcomes = [
  "unchanged",
  "repairable",
  "repaired",
  "not-indexed",
  "deleted",
  "revoked",
] as const;

function decodeReport(value: unknown, mode: Mode) {
  const raw = object(value);
  if (
    Object.keys(raw).sort().join(",") !==
      "complete,counts,cursor,mode,processed" ||
    raw.mode !== (mode === "apply" ? "migrate" : "dry-run") ||
    typeof raw.complete !== "boolean" ||
    typeof raw.cursor !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      raw.cursor,
    )
  )
    throw new CertificateError("invalid_report");
  const rawCounts = object(raw.counts);
  if (
    Object.keys(rawCounts).sort().join(",") !== [...outcomes].sort().join(",")
  )
    throw new CertificateError("invalid_report");
  const counts = {
    unchanged: count(rawCounts.unchanged),
    repairable: count(rawCounts.repairable),
    repaired: count(rawCounts.repaired),
    "not-indexed": count(rawCounts["not-indexed"]),
    deleted: count(rawCounts.deleted),
    revoked: count(rawCounts.revoked),
  };
  const processed = count(raw.processed);
  if (
    processed < 1 ||
    processed > expectedCount ||
    Object.values(counts).reduce((sum, n) => {
      return sum + n;
    }, 0) !== processed
  )
    throw new CertificateError("invalid_report");
  return { processed, counts, cursor: raw.cursor, complete: raw.complete };
}

function validateProgress(
  prior: ReturnType<typeof decodeReport>,
  report: ReturnType<typeof decodeReport>,
): void {
  if (
    prior.complete ||
    report.processed < prior.processed ||
    report.cursor < prior.cursor ||
    (report.processed > prior.processed && report.cursor === prior.cursor) ||
    outcomes.some((key) => {
      return report.counts[key] < prior.counts[key];
    }) ||
    (report.processed === prior.processed &&
      (!report.complete || report.cursor !== prior.cursor))
  )
    throw new CertificateError("invalid_report");
}

// Every nonempty stdout line is part of the protocol. Never search backwards
// for a success-looking line or ignore malformed output/stderr.
export function validateReport(
  output: { stdout: string; stderr: string; exitCode: number | null },
  mode: Mode,
) {
  if (output.exitCode !== 0 || output.stderr !== "")
    throw new CertificateError("operation_failed");
  if (!output.stdout.endsWith("\n"))
    throw new CertificateError("incomplete_report");
  const lines = output.stdout.slice(0, -1).split("\n");
  let previous: ReturnType<typeof decodeReport> | undefined;
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CertificateError("invalid_report");
    }
    // The pinned engine emits JSON.stringify records. Require that encoding
    // too, so duplicate keys cannot overwrite a failure-looking field.
    if (JSON.stringify(parsed) !== line)
      throw new CertificateError("invalid_report");
    const report = decodeReport(parsed, mode);
    if (previous) validateProgress(previous, report);
    if (index < lines.length - 1 && report.complete)
      throw new CertificateError("invalid_report");
    previous = report;
  }
  if (!previous?.complete || previous.processed !== expectedCount)
    throw new CertificateError("incomplete_report");
  // Deliberately omit the child cursor from retained output.
  return {
    processed: previous.processed,
    counts: previous.counts,
    complete: true,
  };
}

export interface RecoveryIO {
  readCohort: () => Promise<unknown>;
  runOperation: (mode: Mode) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>;
  emit: (record: Record<string, unknown>) => void;
}

export async function certifyRecovery(
  mode: Mode,
  io: RecoveryIO,
): Promise<boolean> {
  let phase: Phase = "before";
  const cohort = async () => {
    const { counts, hash } = decodeCohort(await io.readCohort());
    io.emit({ mode, phase, counts, hash });
    if (
      hash !== expectedHash ||
      counts.goals !== expectedCount ||
      counts.threads !== expectedCount ||
      counts.receipts !== expectedCount ||
      counts.active !== 0 ||
      counts.complete !== 3819 ||
      counts.paused !== 143 ||
      counts.blocked !== 200 ||
      counts.nonterminal !== 0 ||
      counts.pending !== 0
    )
      throw new CertificateError("cohort_mismatch");
  };
  const operation = async (operationMode: Mode, requireRepaired: boolean) => {
    io.emit({ mode, phase, complete: false });
    const report = validateReport(
      await io.runOperation(operationMode),
      operationMode,
    );
    io.emit({ mode, phase, ...report });
    if (
      report.counts["not-indexed"] !== 0 ||
      report.counts.deleted !== 0 ||
      report.counts.revoked !== 0 ||
      (operationMode === "dry-run" && report.counts.repaired !== 0) ||
      ((operationMode === "apply" || requireRepaired) &&
        report.counts.repairable !== 0)
    )
      throw new CertificateError("disallowed_outcome");
  };
  try {
    await cohort();
    phase = "preflight";
    await operation("dry-run", false);
    if (mode === "apply") {
      // Close the inventory window opened by a potentially long preflight.
      phase = "before-apply";
      await cohort();
      phase = "apply";
      await operation("apply", true);
      phase = "verify";
      await operation("dry-run", true);
    }
    phase = "after";
    await cohort();
    io.emit({ mode, phase, complete: true });
    return true;
  } catch (error) {
    // A clear can make the engine fail before reaching final verification.
    // Collect fresh count/hash evidence, without retrying the operation or
    // converting this best-effort diagnostic into a completion certificate.
    if (phase === "preflight" || phase === "apply" || phase === "verify") {
      try {
        const evidence = decodeCohort(await io.readCohort());
        io.emit({ mode, phase: "after-failure", ...evidence, complete: false });
      } catch {
        io.emit({
          mode,
          phase: "after-failure",
          complete: false,
          errorClass: "cohort_read_failed",
        });
      }
    }
    io.emit({
      mode,
      phase,
      complete: false,
      errorClass:
        error instanceof CertificateError
          ? error.errorClass
          : "dependency_failed",
    });
    return false;
  }
}
