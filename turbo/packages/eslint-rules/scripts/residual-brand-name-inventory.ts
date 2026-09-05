import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  RESIDUAL_BRAND_BOUNDARY_CATEGORIES,
  RESIDUAL_BRAND_NAME_WORKSTREAMS,
  type ResidualBrandBoundaryCategory,
  type ResidualBrandBoundaryFileRule,
  type ResidualBrandBoundaryOccurrenceRule,
  type ResidualBrandNameBaselineEntry,
} from "./residual-brand-name-manifest";

const BRAND_WORD_PATTERN = /zero|vm0/giu;
const TOKEN_PATTERN = /[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/gu;
const DATABASE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
const NON_TEXT_EXTENSIONS = new Set([
  ".avif",
  ".bin",
  ".eot",
  ".gif",
  ".gz",
  ".ico",
  ".icns",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".node",
  ".otf",
  ".pdf",
  ".png",
  ".svg",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);
const LOCK_FILE_PATTERN =
  /(?:^|\/)(?:Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|uv\.lock)$/u;
const EVIDENCE_LIMIT = 3;

export interface BrandOccurrence {
  readonly column: number;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly token: string;
}

export interface BrandFileClassification {
  readonly category: ResidualBrandBoundaryCategory;
  readonly file: string;
  readonly ruleId: string;
}

export interface BrandInventory {
  readonly databaseIdentifiers: readonly string[];
  readonly occurrences: readonly BrandOccurrence[];
  readonly scannedFileCount: number;
  readonly skippedFiles: readonly BrandFileClassification[];
}

export interface BrandBoundaryMatch {
  readonly category: ResidualBrandBoundaryCategory;
  readonly ruleId: string;
}

export interface ResidualBrandName {
  readonly evidence: readonly string[];
  readonly name: string;
  readonly occurrenceCount: number;
}

export interface ResidualBrandNameClassification {
  readonly boundaryOccurrenceCounts: readonly (BrandBoundaryMatch & {
    readonly occurrenceCount: number;
  })[];
  readonly residual: readonly ResidualBrandName[];
}

export interface ResidualBrandNameClassificationInput {
  readonly databaseIdentifiers: readonly string[];
  readonly occurrenceRules: readonly ResidualBrandBoundaryOccurrenceRule[];
  readonly occurrences: readonly BrandOccurrence[];
}

export interface ResidualBrandNameGuardInput extends ResidualBrandNameClassificationInput {
  readonly baseline: readonly ResidualBrandNameBaselineEntry[];
  readonly skippedFiles: readonly BrandFileClassification[];
}

/**
 * A token carries a brand name when `zero` or `vm0` starts one of its word
 * segments. The leading-lowercase guard keeps `normalizeRouteBindings` and
 * other words that merely contain the letters out of the inventory.
 */
export function brandWordsIn(token: string): readonly string[] {
  const words: string[] = [];
  for (const match of token.matchAll(BRAND_WORD_PATTERN)) {
    const previous = match.index === 0 ? "" : token.charAt(match.index - 1);
    const continuesLowerCaseWord =
      /[a-z]/u.test(match[0].charAt(0)) && /[a-z0-9]/u.test(previous);
    if (continuesLowerCaseWord) continue;
    words.push(match[0]);
  }
  return words;
}

export function hasBrandName(token: string): boolean {
  return brandWordsIn(token).length > 0;
}

export function repositoryRootFrom(scriptDirectory: string): string {
  return path.resolve(scriptDirectory, "../../../..");
}

function listTrackedFiles(repositoryRoot: string): readonly string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
  });
  return output.split("\0").filter((file) => {
    return file.length > 0;
  });
}

function isTextFile(file: string): boolean {
  return (
    !NON_TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) &&
    !LOCK_FILE_PATTERN.test(file)
  );
}

function collectBrandTokens(
  file: string,
  content: string,
  onOccurrence: (occurrence: BrandOccurrence) => void,
): void {
  const lines = content.split("\n");
  for (const [index, text] of lines.entries()) {
    if (!/zero|vm0/iu.test(text)) continue;
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      if (!hasBrandName(match[0])) continue;
      onOccurrence({
        column: match.index + 1,
        file,
        line: index + 1,
        text,
        token: match[0],
      });
    }
  }
}

export function collectBrandInventory(args: {
  readonly fileRules: readonly ResidualBrandBoundaryFileRule[];
  readonly repositoryRoot: string;
}): BrandInventory {
  const databaseIdentifiers = new Set<string>();
  const occurrences: BrandOccurrence[] = [];
  const skippedFiles: BrandFileClassification[] = [];
  let scannedFileCount = 0;

  for (const file of listTrackedFiles(args.repositoryRoot)) {
    if (!isTextFile(file)) continue;
    const absolute = path.join(args.repositoryRoot, file);
    if (!fs.statSync(absolute).isFile()) continue;
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) continue;
    const content = buffer.toString("utf8");
    if (!/zero|vm0/iu.test(content)) continue;

    const fileRule = args.fileRules.find((rule) => {
      return rule.paths.test(file);
    });
    if (fileRule) {
      skippedFiles.push({
        category: fileRule.category,
        file,
        ruleId: fileRule.id,
      });
      if (fileRule.harvestsDatabaseIdentifiers) {
        collectBrandTokens(file, content, (occurrence) => {
          if (DATABASE_IDENTIFIER_PATTERN.test(occurrence.token)) {
            databaseIdentifiers.add(occurrence.token);
          }
        });
      }
      continue;
    }

    scannedFileCount += 1;
    collectBrandTokens(file, content, (occurrence) => {
      occurrences.push(occurrence);
    });
  }

  return {
    databaseIdentifiers: [...databaseIdentifiers].sort(),
    occurrences,
    scannedFileCount,
    skippedFiles,
  };
}

export function matchBrandBoundaryRule(args: {
  readonly databaseIdentifiers: readonly string[];
  readonly occurrence: BrandOccurrence;
  readonly rules: readonly ResidualBrandBoundaryOccurrenceRule[];
}): BrandBoundaryMatch | undefined {
  const { occurrence } = args;
  const preceding = occurrence.text.slice(0, occurrence.column - 1);
  const following = occurrence.text.slice(
    occurrence.column - 1 + occurrence.token.length,
  );
  const rule = args.rules.find((candidate) => {
    if (candidate.paths && !candidate.paths.test(occurrence.file)) return false;
    if (candidate.tokens && !candidate.tokens.includes(occurrence.token)) {
      return false;
    }
    if (
      candidate.tokenPattern &&
      !candidate.tokenPattern.test(occurrence.token)
    ) {
      return false;
    }
    if (candidate.before && !candidate.before.test(preceding)) return false;
    if (candidate.after && !candidate.after.test(following)) return false;
    if (candidate.line && !candidate.line.test(occurrence.text)) return false;
    if (
      candidate.matchesDatabaseIdentifier &&
      !args.databaseIdentifiers.includes(occurrence.token)
    ) {
      return false;
    }
    return true;
  });
  if (!rule) return undefined;
  return { category: rule.category, ruleId: rule.id };
}

export function classifyBrandOccurrences(
  args: ResidualBrandNameClassificationInput,
): ResidualBrandNameClassification {
  const boundaryCounts = new Map<
    string,
    BrandBoundaryMatch & { count: number }
  >();
  const residual = new Map<
    string,
    { count: number; evidence: string[]; name: string }
  >();

  for (const occurrence of args.occurrences) {
    const boundary = matchBrandBoundaryRule({
      databaseIdentifiers: args.databaseIdentifiers,
      occurrence,
      rules: args.occurrenceRules,
    });
    if (boundary) {
      const existing = boundaryCounts.get(boundary.ruleId);
      if (existing) {
        existing.count += 1;
      } else {
        boundaryCounts.set(boundary.ruleId, { ...boundary, count: 1 });
      }
      continue;
    }
    const existing = residual.get(occurrence.token) ?? {
      count: 0,
      evidence: [],
      name: occurrence.token,
    };
    existing.count += 1;
    if (existing.evidence.length < EVIDENCE_LIMIT) {
      existing.evidence.push(`${occurrence.file}:${occurrence.line}`);
    }
    residual.set(occurrence.token, existing);
  }

  return {
    boundaryOccurrenceCounts: [...boundaryCounts.values()]
      .map((entry) => {
        return {
          category: entry.category,
          occurrenceCount: entry.count,
          ruleId: entry.ruleId,
        };
      })
      .sort((left, right) => {
        return left.ruleId.localeCompare(right.ruleId);
      }),
    residual: [...residual.values()]
      .map((entry) => {
        return {
          evidence: entry.evidence,
          name: entry.name,
          occurrenceCount: entry.count,
        };
      })
      .sort((left, right) => {
        return left.name.localeCompare(right.name);
      }),
  };
}

export function assertResidualBrandNameBaseline(
  baseline: readonly ResidualBrandNameBaselineEntry[],
): void {
  const errors: string[] = [];
  const seen = new Map<string, number>();

  for (const [index, entry] of baseline.entries()) {
    const previousIndex = seen.get(entry.name);
    if (previousIndex === undefined) {
      seen.set(entry.name, index);
    } else {
      errors.push(
        `${entry.name}: duplicate baseline entry at ${previousIndex} and ${index}`,
      );
    }
    if (!hasBrandName(entry.name)) {
      errors.push(`${entry.name}: entry ${index} carries no brand name`);
    }
    if (!/^#\d+$/u.test(entry.ownerIssue)) {
      errors.push(`${entry.name}: ownerIssue must be an exact GitHub issue`);
    }
    if (
      !RESIDUAL_BRAND_NAME_WORKSTREAMS.some((workstream) => {
        return workstream.id === entry.workstream;
      })
    ) {
      errors.push(`${entry.name}: unknown workstream ${entry.workstream}`);
    }
    if (entry.reason.trim().length < 20) {
      errors.push(`${entry.name}: reason must explain the remaining work`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      [
        "Residual brand-name baseline is invalid",
        ...errors.map((error) => {
          return `- ${error}`;
        }),
      ].join("\n"),
    );
  }
}

export function buildResidualBrandNameReport(args: {
  readonly baseline: readonly ResidualBrandNameBaselineEntry[];
  readonly classification: ResidualBrandNameClassification;
  readonly skippedFiles: readonly BrandFileClassification[];
}): string {
  const fileCounts = new Map<string, number>();
  for (const skipped of args.skippedFiles) {
    fileCounts.set(
      `${skipped.category}\t${skipped.ruleId}`,
      (fileCounts.get(`${skipped.category}\t${skipped.ruleId}`) ?? 0) + 1,
    );
  }
  const baselineByName = new Map(
    args.baseline.map((entry) => {
      return [entry.name, entry] as const;
    }),
  );
  const workstreamCounts = new Map<
    string,
    { names: number; occurrences: number }
  >(
    RESIDUAL_BRAND_NAME_WORKSTREAMS.map((workstream) => {
      return [workstream.id, { names: 0, occurrences: 0 }] as const;
    }),
  );
  let unclassified = 0;
  for (const residual of args.classification.residual) {
    const entry = baselineByName.get(residual.name);
    if (!entry) {
      unclassified += 1;
      continue;
    }
    const counts = workstreamCounts.get(entry.workstream);
    if (!counts) continue;
    counts.names += 1;
    counts.occurrences += residual.occurrenceCount;
  }

  return [
    "Residual brand-name inventory",
    "",
    "Approved boundaries (whole files):",
    ...[...fileCounts.entries()].sort().map(([key, count]) => {
      const [category, ruleId] = key.split("\t");
      return `- ${category} / ${ruleId}: ${count} files`;
    }),
    "",
    "Approved boundaries (occurrences):",
    ...args.classification.boundaryOccurrenceCounts.map((entry) => {
      return `- ${entry.category} / ${entry.ruleId}: ${entry.occurrenceCount} occurrences`;
    }),
    "",
    "Baseline (cleanup still owed):",
    ...RESIDUAL_BRAND_NAME_WORKSTREAMS.map((workstream) => {
      const counts = workstreamCounts.get(workstream.id) ?? {
        names: 0,
        occurrences: 0,
      };
      return `- ${workstream.id} ${workstream.title} (${workstream.ownerIssue}): ${counts.names} names, ${counts.occurrences} occurrences`;
    }),
    "",
    `Unclassified names: ${unclassified}`,
  ].join("\n");
}

function describeResidual(residual: ResidualBrandName): string {
  return [
    `- ${residual.name} (${residual.occurrenceCount} occurrences)`,
    ...residual.evidence.map((evidence) => {
      return `    ${evidence}`;
    }),
  ].join("\n");
}

export function assertResidualBrandNameInventory(
  input: ResidualBrandNameGuardInput,
): ResidualBrandNameClassification {
  assertResidualBrandNameBaseline(input.baseline);
  const classification = classifyBrandOccurrences(input);
  const baselineByName = new Map(
    input.baseline.map((entry) => {
      return [entry.name, entry] as const;
    }),
  );
  const residualByName = new Map(
    classification.residual.map((residual) => {
      return [residual.name, residual] as const;
    }),
  );

  const unclassified = classification.residual.filter((residual) => {
    return !baselineByName.has(residual.name);
  });
  const stale = input.baseline.filter((entry) => {
    return !residualByName.has(entry.name);
  });

  const sections: string[] = [];
  if (unclassified.length > 0) {
    sections.push(
      [
        `Unclassified brand names (${unclassified.length}):`,
        ...unclassified.map(describeResidual),
        "Rename the name, or record it: add a boundary rule to",
        "residual-brand-name-manifest.ts when the name is an approved boundary,",
        "or add a baseline entry with an owning workstream and a reason.",
      ].join("\n"),
    );
  }
  if (stale.length > 0) {
    sections.push(
      [
        `Stale baseline entries (${stale.length}):`,
        ...stale.map((entry) => {
          return `- ${entry.name} (${entry.workstream}, ${entry.ownerIssue}): no occurrence remains, delete the baseline entry`;
        }),
      ].join("\n"),
    );
  }

  if (sections.length > 0) {
    throw new Error(
      [
        "Residual brand-name ratchet failed",
        "",
        sections.join("\n\n"),
        "",
        buildResidualBrandNameReport({
          baseline: input.baseline,
          classification,
          skippedFiles: input.skippedFiles,
        }),
      ].join("\n"),
    );
  }

  return classification;
}

export function assertEveryBoundaryCategoryHasRule(args: {
  readonly fileRules: readonly ResidualBrandBoundaryFileRule[];
  readonly occurrenceRules: readonly ResidualBrandBoundaryOccurrenceRule[];
}): void {
  const covered = new Set<string>([
    ...args.fileRules.map((rule) => {
      return rule.category;
    }),
    ...args.occurrenceRules.map((rule) => {
      return rule.category;
    }),
  ]);
  const missing = RESIDUAL_BRAND_BOUNDARY_CATEGORIES.filter((category) => {
    return !covered.has(category);
  });
  if (missing.length > 0) {
    throw new Error(
      `Boundary categories without a rule: ${missing.join(", ")}. Every category in #31813 must be encoded.`,
    );
  }
}
