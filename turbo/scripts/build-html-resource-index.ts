import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  selectResourceCandidates,
  type GenerationTarget,
} from "../packages/core/src/resource-registry";

const HTML_RESOURCE_TARGETS = [
  "website",
  "report",
  "poster",
  "dashboard-design",
  "mobile-app-design",
  "docs-design",
] as const satisfies readonly GenerationTarget[];

type HtmlResourceTarget = (typeof HTML_RESOURCE_TARGETS)[number];

interface HtmlResourceIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: {
    readonly path: string;
    readonly archive?: {
      readonly type: "tar.gz";
      readonly sha256: string;
    };
    readonly pull?: {
      readonly command: string;
      readonly resolvedPath: string;
    };
  };
}

interface HtmlResourceIndex {
  readonly schemaVersion: 1;
  readonly target: HtmlResourceTarget;
  readonly source: {
    readonly repo: string;
    readonly ref: string;
  };
  readonly selectionPolicy: {
    readonly mode: "on-demand";
    readonly instructions: readonly string[];
  };
  readonly templates: readonly HtmlResourceIndexEntry[];
  readonly skills: readonly HtmlResourceIndexEntry[];
  readonly designSystems: readonly HtmlResourceIndexEntry[];
}

interface HtmlResourceIndexManifest {
  readonly schemaVersion: 1;
  readonly files: readonly {
    readonly target: HtmlResourceTarget;
    readonly path: string;
    readonly counts: {
      readonly templates: number;
      readonly skills: number;
      readonly designSystems: number;
    };
    readonly byteSize: number;
    readonly sha256: string;
  }[];
}

type CandidateKind = "template" | "skill" | "design-system";

type ResourceCandidate = ReturnType<
  typeof selectResourceCandidates
>["candidates"]["templates"][number];

const ON_DEMAND_SELECTION_INSTRUCTIONS = [
  "This index contains templates and target-specific skills for the current target, plus design systems for HTML generation.",
  "Derive keywords from the user's request and search this target-specific index.",
  "Select resources only when they are useful for the request. There is no fixed selection count for any resource type.",
  "After selecting, resolve and download only the selected resources. Do not fetch unselected candidates.",
  "For a selected entry without source.archive, resolve source.path from this index's pinned source.repo@source.ref.",
  "For a selected entry with source.archive, run its exact source.pull.command and then use source.pull.resolvedPath. Do not construct or guess a direct R2 URL.",
] as const;

function readOption(name: string): string | undefined {
  const optionIndex = process.argv.indexOf(name);
  if (optionIndex === -1) {
    return undefined;
  }

  const value = process.argv[optionIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toIndexEntry(
  target: HtmlResourceTarget,
  entry: ResourceCandidate,
  expectedKind: CandidateKind,
): HtmlResourceIndexEntry {
  if (entry.kind !== expectedKind) {
    throw new Error(`${entry.id} is not a ${expectedKind}`);
  }
  if (
    (expectedKind === "template" || expectedKind === "skill") &&
    !entry.targets?.includes(target)
  ) {
    throw new Error(`${entry.id} does not target ${target}`);
  }
  if (!entry.source.path) {
    throw new Error(`${entry.id} has no source.path`);
  }
  if (entry.source.repo || entry.source.ref) {
    throw new Error(`${entry.id} overrides the fixed Git source with repo/ref`);
  }

  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source.archive
      ? {
          path: entry.source.path,
          archive: entry.source.archive,
          pull: {
            command: `zero resource pull ${entry.id} --dir ./generated/resources`,
            resolvedPath: `./generated/resources/${entry.source.path}`,
          },
        }
      : {
          path: entry.source.path,
        },
  };
}

function buildCandidateGroup(
  target: HtmlResourceTarget,
  entries: readonly ResourceCandidate[],
  expectedKind: CandidateKind,
): readonly HtmlResourceIndexEntry[] {
  const resources = entries
    .map((entry) => {
      return toIndexEntry(target, entry, expectedKind);
    })
    .sort((left, right) => {
      return left.id.localeCompare(right.id);
    });
  const uniqueIds = new Set(resources.map((resource) => resource.id));

  if (uniqueIds.size !== resources.length) {
    throw new Error(`Duplicate ${expectedKind} ids found for ${target}`);
  }

  return resources;
}

function buildTargetIndex(target: HtmlResourceTarget): HtmlResourceIndex {
  const candidateSlice = selectResourceCandidates(target);

  return {
    schemaVersion: 1,
    target,
    source: candidateSlice.source,
    selectionPolicy: {
      mode: "on-demand",
      instructions: ON_DEMAND_SELECTION_INSTRUCTIONS,
    },
    templates: buildCandidateGroup(
      target,
      candidateSlice.candidates.templates,
      "template",
    ),
    skills: buildCandidateGroup(
      target,
      candidateSlice.candidates.skills,
      "skill",
    ),
    designSystems: buildCandidateGroup(
      target,
      candidateSlice.candidates.designSystems,
      "design-system",
    ),
  };
}

async function main(): Promise<void> {
  const outputDirOption = readOption("--output-dir");
  if (!outputDirOption) {
    throw new Error("--output-dir is required");
  }

  const outputDir = path.resolve(outputDirOption);
  await mkdir(outputDir, { recursive: true });

  const files: HtmlResourceIndexManifest["files"][number][] = [];

  for (const target of HTML_RESOURCE_TARGETS) {
    const index = buildTargetIndex(target);

    const fileName = `${target}.json`;
    const contents = serializeJson(index);
    await writeFile(path.join(outputDir, fileName), contents, "utf8");
    files.push({
      target,
      path: fileName,
      counts: {
        templates: index.templates.length,
        skills: index.skills.length,
        designSystems: index.designSystems.length,
      },
      byteSize: Buffer.byteLength(contents),
      sha256: sha256(contents),
    });
  }

  if (files.length === 0) {
    throw new Error("No HTML resource indexes were generated");
  }

  const manifest: HtmlResourceIndexManifest = {
    schemaVersion: 1,
    files,
  };
  await writeFile(
    path.join(outputDir, "manifest.json"),
    serializeJson(manifest),
    "utf8",
  );

  process.stdout.write(`${outputDir}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
