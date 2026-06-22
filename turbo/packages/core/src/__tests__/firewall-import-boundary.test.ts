/// <reference types="node" />

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json";

function staticModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /^\s*import\s+(?:type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["'];?/gm,
  )) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["'];?/gm)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(
    /^\s*export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["'];?/gm,
  )) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("core firewall import boundary", () => {
  it("keeps runtime firewalls out of the package root source", () => {
    const rootEntrypoint = fs.readFileSync(
      path.resolve(import.meta.dirname, "../index.ts"),
      "utf-8",
    );

    for (const specifier of staticModuleSpecifiers(rootEntrypoint)) {
      expect(specifier).not.toMatch(/^\.\/firewalls(?:\/|$)/);
      expect(specifier).not.toMatch(/^@vm0\/connectors\/firewalls(?:\/|$)/);
    }
  });

  it("does not expose the core firewall alias subpath or source file", () => {
    expect(packageJson.exports).not.toHaveProperty("./firewalls");
    expect(
      fs.existsSync(path.resolve(import.meta.dirname, "../firewalls.ts")),
    ).toBe(false);
    expect(
      fs.existsSync(path.resolve(import.meta.dirname, "../firewalls/index.ts")),
    ).toBe(false);
  });
});
