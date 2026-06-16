import { describe, expect, it } from "vitest";

import type { Firewall } from "@vm0/connectors/firewall-types";
import {
  type BuiltinFirewallCatalog,
  type PythonBuiltinFirewallCatalogFile,
  buildBuiltinFirewallCatalog,
  renderPythonBuiltinFirewallCatalogFiles,
} from "../builtin-firewall-catalog";

function testFirewall(name: string, rules: readonly string[] = []): Firewall {
  return {
    name,
    apis: [
      {
        base: `https://${name}.example.com`,
        auth: {},
        ...(rules.length > 0
          ? {
              permissions: [
                {
                  name: "test",
                  rules: [...rules],
                },
              ],
            }
          : {}),
      },
    ],
  };
}

function testCatalog(firewalls: readonly Firewall[]): BuiltinFirewallCatalog {
  return {
    firewalls: Object.fromEntries(
      firewalls.map((firewall) => {
        return [firewall.name, firewall];
      }),
    ),
  };
}

function findGeneratedFile(
  files: readonly PythonBuiltinFirewallCatalogFile[],
  path: string,
): PythonBuiltinFirewallCatalogFile {
  const file = files.find((candidate) => {
    return candidate.path === path;
  });
  if (file === undefined) {
    throw new Error(`missing generated file: ${path}`);
  }
  return file;
}

function jsonPartFromModule(file: PythonBuiltinFirewallCatalogFile): string {
  const prefix = "JSON_PART = ";
  const line = file.content.split("\n").find((candidate) => {
    return candidate.startsWith(prefix);
  });
  if (line === undefined) {
    throw new Error(`missing JSON_PART assignment in ${file.path}`);
  }

  const literal = line.slice(prefix.length);
  if (literal.startsWith('r"""') && literal.endsWith('"""')) {
    return literal.slice(4, -3);
  }
  if (literal.startsWith("r'''") && literal.endsWith("'''")) {
    return literal.slice(4, -3);
  }

  const value: unknown = JSON.parse(literal);
  if (typeof value !== "string") {
    throw new Error(`JSON_PART assignment in ${file.path} is not a string`);
  }
  return value;
}

describe("builtin firewall catalog", () => {
  it("includes connector and model-provider firewalls", () => {
    const catalog = buildBuiltinFirewallCatalog();

    expect(catalog.firewalls.github?.apis[0]?.base).toBe(
      "https://api.github.com",
    );
    expect(catalog.firewalls.fal).not.toHaveProperty("label");
    expect(
      catalog.firewalls["model-provider:openai-api-key"]?.apis[0]?.base,
    ).toBe("https://api.openai.com/v1/responses");
  });

  it("preserves connector auth templates", () => {
    const catalog = buildBuiltinFirewallCatalog();

    expect(catalog.firewalls.cloudflare?.apis[0]?.auth.headers).toStrictEqual({
      Authorization: "Bearer ${{ secrets.CLOUDFLARE_TOKEN }}",
    });
    expect(catalog.firewalls.slock?.apis[0]?.auth.headers).toStrictEqual({
      Authorization: "Bearer ${{ secrets.SLOCK_TOKEN }}",
      "X-Server-Id": "${{ secrets.SLOCK_SERVER_ID }}",
    });
    expect(catalog.firewalls.serpapi?.apis[0]?.auth.query).toStrictEqual({
      api_key: "${{ secrets.SERPAPI_TOKEN }}",
    });
    expect(catalog.firewalls.aws?.apis[0]?.auth.awsSigv4).toStrictEqual({
      accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
      secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
      sessionToken: "${{ secrets.AWS_SESSION_TOKEN }}",
    });
  });

  it("renders a deterministic Python package", () => {
    const firstRender = renderPythonBuiltinFirewallCatalogFiles();
    const secondRender = renderPythonBuiltinFirewallCatalogFiles();
    const paths = firstRender.map((file) => {
      return file.path;
    });

    expect(secondRender).toStrictEqual(firstRender);
    expect(paths).toContain("__init__.py");
    expect(paths).toContain("loader.py");
    expect(paths).toContain("manifest.py");
    expect(paths).toContain("github_0.py");
    expect(paths).toContain("model_provider_openai_api_key_0.py");
    expect(findGeneratedFile(firstRender, "__init__.py").content).toContain(
      "BUILTIN_FIREWALLS = _BuiltinFirewallCatalog()",
    );
    expect(findGeneratedFile(firstRender, "__init__.py").content).not.toContain(
      "importlib",
    );
    expect(findGeneratedFile(firstRender, "loader.py").content).toContain(
      "from . import github_0",
    );
    expect(findGeneratedFile(firstRender, "manifest.py").content).toContain(
      '"github": ("github_0",),',
    );
    expect(findGeneratedFile(firstRender, "github_0.py").content).toContain(
      "JSON_PART = ",
    );
    for (const file of firstRender) {
      expect(file.content.length).toBeLessThan(250_000);
    }
  });

  it("renders manifest entries in sorted firewall-name order", () => {
    const files = renderPythonBuiltinFirewallCatalogFiles({
      catalog: testCatalog([testFirewall("zeta"), testFirewall("alpha")]),
    });
    const manifest = findGeneratedFile(files, "manifest.py").content;

    expect(manifest.indexOf('"alpha"')).toBeLessThan(
      manifest.indexOf('"zeta"'),
    );
  });

  it("uses safe deterministic module names for non-module firewall names", () => {
    const files = renderPythonBuiltinFirewallCatalogFiles({
      catalog: testCatalog([
        testFirewall("model-provider:openai-api-key"),
        testFirewall("123-special"),
      ]),
    });
    const manifest = findGeneratedFile(files, "manifest.py").content;
    const paths = files.map((file) => {
      return file.path;
    });

    expect(manifest).toContain(
      '"model-provider:openai-api-key": ("model_provider_openai_api_key_0",),',
    );
    expect(manifest).toContain('"123-special": ("firewall_123_special_0",),');
    expect(paths).toContain("model_provider_openai_api_key_0.py");
    expect(paths).toContain("firewall_123_special_0.py");
  });

  it("deduplicates sanitized module-name collisions", () => {
    const files = renderPythonBuiltinFirewallCatalogFiles({
      catalog: testCatalog([testFirewall("a-b"), testFirewall("a:b")]),
    });
    const manifest = findGeneratedFile(files, "manifest.py").content;
    const paths = files.map((file) => {
      return file.path;
    });

    expect(manifest).toContain('"a-b": ("a_b_0",),');
    expect(manifest).toContain('"a:b": ("a_b_2_0",),');
    expect(paths).toContain("a_b_0.py");
    expect(paths).toContain("a_b_2_0.py");
  });

  it("splits large firewall JSON into multiple generated modules", () => {
    const files = renderPythonBuiltinFirewallCatalogFiles({
      catalog: testCatalog([
        testFirewall("chunky", [
          "GET /alpha-alpha-alpha-alpha-alpha",
          "POST /beta-beta-beta-beta-beta",
        ]),
      ]),
      maxJsonChunkLength: 25,
    });
    const manifest = findGeneratedFile(files, "manifest.py").content;
    const loader = findGeneratedFile(files, "loader.py").content;
    const partFiles = files.filter((file) => {
      return file.path.startsWith("chunky_");
    });

    expect(partFiles.length).toBeGreaterThan(1);
    expect(manifest).toContain('"chunky": (\n        "chunky_0",');
    expect(loader).toContain(
      "        return (\n            chunky_0.JSON_PART,",
    );
    for (const file of partFiles) {
      expect(file.content).toContain("JSON_PART = ");
    }
  });

  it("renders chunk literals that preserve quote and unicode boundaries", () => {
    const emoji = "\u{1f600}";
    const firewall = testFirewall("chunky", [`GET /emoji-${emoji}`]);
    const files = renderPythonBuiltinFirewallCatalogFiles({
      catalog: testCatalog([firewall]),
      maxJsonChunkLength: 1,
    });
    const partFiles = files.filter((file) => {
      return file.path.startsWith("chunky_");
    });
    const renderedJson = partFiles.map(jsonPartFromModule).join("");

    expect(partFiles.length).toBeGreaterThan(1);
    expect(renderedJson).toContain("\\ud83d\\ude00");
    expect(renderedJson).not.toContain(emoji);
    expect(JSON.parse(renderedJson)).toStrictEqual(firewall);
  });
});
