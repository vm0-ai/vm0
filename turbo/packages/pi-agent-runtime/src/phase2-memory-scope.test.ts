import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PRODUCTION_FILES = [
  "phase2-memory.ts",
  "phase2-memory-filesystem.ts",
  "phase2-memory-tools.ts",
  "phase2-memory-types.ts",
  "phase2-memory-prompt.ts",
] as const;

async function productionSource(): Promise<string> {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  return (
    await Promise.all(
      PRODUCTION_FILES.map(async (file) => {
        return await readFile(`${directory}${file}`, "utf8");
      }),
    )
  ).join("\n");
}

describe("Pi memory Phase 2 scope boundary", () => {
  it("has no persistence, publication, scheduling, foreground, or release integration", async () => {
    const source = await productionSource();
    const forbidden = [
      /from ["']@aws-sdk\//u,
      /from ["']@okouai\/db/u,
      /\bstorage_versions\b/u,
      /\bsucceedPiMemoryPhase2Job\b/u,
      /\bfailPiMemoryPhase2Job\b/u,
      /\b(?:get|load|lookup|download|upload)Storage(?:Archive|Head|Version)\b/u,
      /\b(?:create|register|publish)StorageVersion\b/u,
      /\b(?:advance|compareAndSwap|update)MemoryHead\b/u,
      /\b(?:lineage|reconciliation)Service\b/u,
      /\b(?:cron|scheduler|worker)Route\b/u,
      /\bfeatureSwitch\b/u,
      /\bchargeCredits?\b/u,
      /\bcreateAgentRun\b/u,
      /\breleaseProduction\b/u,
      /from ["']node:child_process["']/u,
    ];
    for (const pattern of forbidden) {
      expect(source).not.toMatch(pattern);
    }
  });

  it("does not log content or expose a generic transport/tool surface", async () => {
    const source = await productionSource();
    expect(source).not.toMatch(
      /\b(?:console|logger|log)\.(?:debug|info|warn|error)\b/u,
    );
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/\bcreateBashTool\b/u);
    expect(source).not.toMatch(/\bcreatePiAgentSessionForRuntime\b/u);
  });
});
