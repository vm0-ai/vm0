import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  compareRuntimeApiSchemas,
  renderCompatReport,
  renderCompatReportJson,
} from "./compat";
import {
  buildRuntimeApiSchemaDocument,
  readRuntimeApiSchemaDocument,
  renderRuntimeApiSchemaDocument,
} from "./schema";

interface ParsedArgs {
  readonly command: string | undefined;
  readonly options: Readonly<Record<string, string | boolean>>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "build") {
    await buildCommand(args.options);
    return;
  }

  if (args.command === "lint") {
    await lintCommand(args.options);
    return;
  }

  printUsage();
  process.exitCode = 2;
}

async function buildCommand(
  options: Readonly<Record<string, string | boolean>>,
): Promise<void> {
  const out = readStringOption(options, "out") ?? "runtime-api-schema.json";
  const outputPath = resolve(out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderRuntimeApiSchemaDocument());
  console.log(`Runtime API schema written to ${outputPath}`);
}

async function lintCommand(
  options: Readonly<Record<string, string | boolean>>,
): Promise<void> {
  const against = readStringOption(options, "against");
  if (!against) {
    throw new Error("Missing required --against <path> option");
  }

  const currentPath = readStringOption(options, "current");
  const reportOut = readStringOption(options, "report-out");
  const warnOnly = options["warn-only"] === true;

  let online;
  try {
    online = await readRuntimeApiSchemaDocument(resolve(against));
  } catch (error) {
    console.warn(
      `::warning::Online runtime API schema could not be read from ${against}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.warn(
      "Runtime API compatibility report skipped because no online schema is available yet.",
    );
    return;
  }

  const current = currentPath
    ? await readRuntimeApiSchemaDocument(resolve(currentPath))
    : buildRuntimeApiSchemaDocument();

  const findings = compareRuntimeApiSchemas(online, current);
  const report = renderCompatReport(findings);
  console.log(report);

  if (reportOut) {
    const reportPath = resolve(reportOut);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, renderCompatReportJson(findings));
    console.log(
      `Runtime API compatibility JSON report written to ${reportPath}`,
    );
  }

  for (const finding of findings) {
    console.error(
      `::error title=Runtime API compatibility break::${finding.route} ${finding.path}: ${finding.problem} Impact: ${finding.impact}`,
    );
  }

  if (findings.length > 0 && !warnOnly) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { command, options };
}

function readStringOption(
  options: Readonly<Record<string, string | boolean>>,
  key: string,
): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function printUsage(): void {
  console.log(`Usage:
  tsx src/runtime-api-schema/cli.ts build --out runtime-api-schema.json
  tsx src/runtime-api-schema/cli.ts lint --against online-schema.json [--current current-schema.json] [--report-out report.json] [--warn-only]
`);
}

await main();
