import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "../contracts/model-price-tiers";

const generatedModelUsagePath = fileURLToPath(
  new URL(
    "../../../../../crates/runner/mitm-addon/src/usage/generated_model_usage.py",
    import.meta.url,
  ),
);

function pythonInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid model usage threshold: ${String(value)}`);
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

function renderModelUsageContract(): string {
  const entries = Object.entries(MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS);
  const lines = [
    '"""Generated model usage contracts shared with TypeScript.',
    "",
    "Do not edit by hand; regenerate with",
    "``cd turbo && pnpm -F @vm0/api-contracts generate:python``.",
    '"""',
    "",
    "from typing import Final",
    "",
    "MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS: Final[dict[str, int]] = {",
  ];
  for (const [model, threshold] of entries) {
    lines.push(`    ${JSON.stringify(model)}: ${pythonInteger(threshold)},`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

export async function generatePythonBindings(): Promise<void> {
  await mkdir(dirname(generatedModelUsagePath), { recursive: true });
  await writeFile(generatedModelUsagePath, renderModelUsageContract());
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  void generatePythonBindings().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
