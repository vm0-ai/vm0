import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { getAllConnectorFirewalls } from "@vm0/connectors/firewalls/all";
import { getConnectorFirewall } from "../firewalls";
import {
  isRuntimeFirewallConnectorType,
  loadConnectorFirewall,
  loadConnectorFirewalls,
  RUNTIME_FIREWALL_CONNECTOR_TYPES,
} from "../firewall-runtime";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function staticValueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm,
  )) {
    specifiers.push(match[1]!);
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["'];?/gm)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function staticValueExportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*export(?:\s+\*|\s+\{[\s\S]*?\})\s+from\s+["']([^"']+)["'];?/gm,
  )) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function staticValueModuleSpecifiers(source: string): string[] {
  return [
    ...staticValueImportSpecifiers(source),
    ...staticValueExportSpecifiers(source),
  ];
}

function dynamicImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

describe("firewall runtime loader", () => {
  it("keeps the runtime loader behind an explicit package subpath", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf-8",
      ),
    ) as { exports: Record<string, unknown> };
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );

    expect(packageJson.exports["./firewalls/runtime"]).toStrictEqual({
      import: "./src/firewall-runtime.ts",
      types: "./src/firewall-runtime.ts",
    });
    expect(rootEntrypoint).not.toContain("firewalls/runtime");
  });

  it("keeps all-catalog access behind an explicit package subpath", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../package.json"),
        "utf-8",
      ),
    ) as { exports: Record<string, unknown> };
    const defaultFirewallEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewalls/index.ts"),
      "utf-8",
    );
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );

    expect(packageJson.exports["./firewalls/all"]).toStrictEqual({
      import: "./src/firewall-runtime-all.ts",
      types: "./src/firewall-runtime-all.ts",
    });
    expect(defaultFirewallEntrypoint).not.toContain("getAllConnectorFirewalls");
    expect(rootEntrypoint).not.toContain("firewalls/all");
  });

  it("does not statically import the eager registry or connector runtime modules", () => {
    const runtimeSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-runtime.ts"),
      "utf-8",
    );
    const helperSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../firewall-placeholder-expansion.ts"),
      "utf-8",
    );

    expect(
      staticValueModuleSpecifiers(runtimeSource).sort(compareStrings),
    ).toStrictEqual(["./firewalls/runtime-loader.generated"]);
    expect(dynamicImportSpecifiers(runtimeSource)).toStrictEqual([
      "./firewall-placeholder-expansion",
    ]);
    expect(
      staticValueModuleSpecifiers(helperSource).sort(compareStrings),
    ).toStrictEqual(["./connector-utils"]);

    for (const source of [runtimeSource, helperSource]) {
      expect(source).not.toContain("./index");
      expect(source).not.toContain("@vm0/connectors/firewalls");
      for (const specifier of staticValueModuleSpecifiers(source)) {
        expect(specifier).not.toMatch(/^\.\/[a-z0-9][a-z0-9-]*\.generated$/);
      }
    }
  });

  it("uses literal dynamic imports in the generated runtime loader", () => {
    const loaderSource = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../firewalls/runtime-loader.generated.ts",
      ),
      "utf-8",
    );
    const dynamicSpecifiers = dynamicImportSpecifiers(loaderSource);

    expect(staticValueModuleSpecifiers(loaderSource)).toStrictEqual([]);
    expect(dynamicSpecifiers).toContain("./slack.generated");
    expect(dynamicSpecifiers).toContain("./github.generated");
    expect(new Set(dynamicSpecifiers).size).toBe(dynamicSpecifiers.length);
    for (const specifier of dynamicSpecifiers) {
      expect(specifier).toMatch(/^\.\/[a-z0-9][a-z0-9-]*\.generated$/);
    }
  });

  it("keeps the runtime manifest synchronized with the sync firewall registry", () => {
    expect(
      [...RUNTIME_FIREWALL_CONNECTOR_TYPES].sort(compareStrings),
    ).toStrictEqual(
      Object.keys(getAllConnectorFirewalls()).sort(compareStrings),
    );
  });

  it("loads and caches expanded connector firewalls", async () => {
    expect(isRuntimeFirewallConnectorType("slack")).toBe(true);
    expect(isRuntimeFirewallConnectorType("cloudinary")).toBe(false);
    await expect(loadConnectorFirewall("cloudinary")).resolves.toBeNull();

    const [firstSlack, secondSlack] = await Promise.all([
      loadConnectorFirewall("slack"),
      loadConnectorFirewall("slack"),
    ]);
    expect(firstSlack).toBe(secondSlack);
    expect(firstSlack).toStrictEqual(getConnectorFirewall("slack"));

    const repeatedSlack = await loadConnectorFirewall("slack");
    expect(repeatedSlack).toBe(firstSlack);
  });

  it("deduplicates batch loads and preserves connector keys", async () => {
    const firewalls = await loadConnectorFirewalls([
      "github",
      "slack",
      "github",
      "cloudinary",
    ]);

    expect(Object.keys(firewalls).sort(compareStrings)).toStrictEqual([
      "github",
      "slack",
    ]);
    expect(firewalls.github).toStrictEqual(getConnectorFirewall("github"));
    expect(firewalls.slack).toBe(await loadConnectorFirewall("slack"));
  });
});
