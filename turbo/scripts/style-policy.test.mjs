import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ESLint } from "eslint";

import {
  baselineGrowthErrors,
  checkStylePolicy,
  prunedBaseline,
} from "./style-policy.mjs";

const EMPTY_ALLOWLIST = {
  version: 1,
  selectors: [],
  styleInjections: [],
  vendorFiles: [],
};

function createWorkspace(testContext, files) {
  const root = mkdtempSync(join(tmpdir(), "vm0-style-policy-"));
  testContext.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function emptyBaseline(legacyClassTokens = []) {
  return {
    version: 1,
    legacyClassTokens,
    cssAtoms: {},
    classUsages: {},
    styleInjections: {},
  };
}

test("freezes existing selector declarations and class dependencies", (t) => {
  const root = createWorkspace(t, {
    "apps/platform/src/example.css": ".legacy { color: red }",
    "apps/platform/src/view.tsx":
      'export const View = () => <div className="legacy" />;',
  });
  const baseline = {
    ...emptyBaseline(["legacy"]),
    cssAtoms: {
      "apps/platform/src/example.css": [
        {
          atRules: [],
          selector: ".legacy",
          property: "color",
          value: "red",
          important: false,
        },
      ],
    },
    classUsages: {
      "apps/platform/src/view.tsx": { legacy: 1 },
    },
  };
  assert.deepEqual(
    checkStylePolicy({ root, allowlist: EMPTY_ALLOWLIST, baseline }).issues,
    [],
  );

  writeFileSync(
    join(root, "apps/platform/src/example.css"),
    ".legacy { color: blue }",
  );
  writeFileSync(
    join(root, "apps/platform/src/view.tsx"),
    'export const View = () => <><div className="legacy" /><div className="legacy" /></>;',
  );
  const result = checkStylePolicy({
    root,
    allowlist: EMPTY_ALLOWLIST,
    baseline,
  });

  assert.equal(
    result.issues.some(({ message }) => {
      return message.includes("Legacy class `legacy` usage grew from 1 to 2");
    }),
    true,
  );
  assert.equal(
    result.issues.some(({ type }) => type === "growth"),
    true,
  );
  assert.equal(
    result.issues.some(({ type }) => type === "stale"),
    true,
  );
});

test("an exact third-party selector allowlist does not authorize siblings", (t) => {
  const file = "apps/platform/src/example.css";
  const root = createWorkspace(t, { [file]: ".adapter { color: blue }" });
  const allowlist = {
    ...EMPTY_ALLOWLIST,
    selectors: [
      {
        file,
        atRules: [],
        selector: ".adapter",
        kind: "third-party-dom-adapter",
        owner: "frontend-infra",
        rationale: "The upstream widget owns this DOM class.",
        upstream: "example-widget",
        removal: "Remove with the widget.",
      },
    ],
  };
  const baseline = emptyBaseline();
  assert.deepEqual(checkStylePolicy({ root, allowlist, baseline }).issues, []);

  writeFileSync(join(root, file), ".adapter, .sibling { color: blue }");
  const result = checkStylePolicy({ root, allowlist, baseline });
  assert.equal(
    result.issues.some(({ type }) => type === "growth"),
    true,
  );
  assert.equal(
    result.issues.some(({ type }) => type === "allowlist"),
    true,
  );
});

test("rejects a new inline stylesheet", (t) => {
  const jsxFile = "packages/ui/src/view.tsx";
  const htmlFile = "apps/platform/src/html.ts";
  const templateFile = "apps/platform/src/template.ts";
  const root = createWorkspace(t, {
    [jsxFile]: 'export const View = () => <style>{".new-class {}"}</style>;',
    [htmlFile]:
      'export const html = "<style>.new-class { color: red }</style>";',
    [templateFile]: "export const html = `<style>${dynamicCss}</style>`;",
  });
  const result = checkStylePolicy({
    root,
    allowlist: EMPTY_ALLOWLIST,
    baseline: emptyBaseline(),
  });

  assert.deepEqual(
    result.issues
      .filter(({ message }) => {
        return message.includes(
          "New inline or injected stylesheet is forbidden",
        );
      })
      .map(({ file }) => file)
      .sort(),
    [htmlFile, jsxFile, templateFile].sort(),
  );
});

test("pins vendored CSS by exact hash", (t) => {
  const file =
    "apps/platform/src/views/css/vendor/uiw-react-markdown-preview-5.2.0.css";
  const original = ".upstream { color: red }";
  const root = createWorkspace(t, { [file]: original });
  const allowlist = {
    ...EMPTY_ALLOWLIST,
    vendorFiles: [
      {
        file,
        sha256: createHash("sha256").update(original).digest("hex"),
        owner: "frontend-platform",
        upstream: "example upstream 1.0.0",
        rationale: "This fixture represents an immutable upstream artifact.",
        removal: "Remove with the fixture upstream.",
      },
    ],
  };
  const baseline = emptyBaseline();
  assert.deepEqual(checkStylePolicy({ root, allowlist, baseline }).issues, []);

  writeFileSync(join(root, file), ".upstream { color: blue }");
  assert.equal(
    checkStylePolicy({ root, allowlist, baseline }).issues.some(({ type }) => {
      return type === "vendor";
    }),
    true,
  );
});

test("the Tailwind lint cannot be disabled inline", async () => {
  const eslint = new ESLint({
    allowInlineConfig: false,
    overrideConfigFile: join(import.meta.dirname, "../eslint.style.config.mjs"),
  });
  const [result] = await eslint.lintText(
    '/* eslint-disable better-tailwindcss/no-unknown-classes */ export const View = () => <div className="new-first-party-selector" />;',
    {
      filePath: join(
        import.meta.dirname,
        "../apps/platform/src/style-policy-fixture.tsx",
      ),
    },
  );

  assert.equal(
    result.messages.some(({ ruleId }) => {
      return ruleId === "better-tailwindcss/no-unknown-classes";
    }),
    true,
  );
});

test("pruning can only remove allowances", () => {
  const baseline = {
    ...emptyBaseline(["legacy"]),
    cssAtoms: {
      "apps/platform/src/example.css": [
        {
          atRules: [],
          selector: ".legacy",
          property: "color",
          value: "red",
          important: false,
        },
      ],
    },
    classUsages: {
      "apps/platform/src/view.tsx": { legacy: 1 },
    },
  };
  const pruned = prunedBaseline(baseline, {
    cssAtoms: {},
    classUsages: {},
    styleInjections: {},
  });

  assert.deepEqual(pruned, emptyBaseline());
});

test("the committed legacy baseline can only shrink", () => {
  const reference = {
    ...emptyBaseline(["legacy"]),
    classUsages: {
      "apps/platform/src/view.tsx": { legacy: 2 },
    },
  };
  const smaller = {
    ...emptyBaseline(["legacy"]),
    classUsages: {
      "apps/platform/src/view.tsx": { legacy: 1 },
    },
  };
  assert.deepEqual(baselineGrowthErrors(smaller, reference), []);

  const expanded = {
    ...smaller,
    legacyClassTokens: ["legacy", "new-class"],
    classUsages: {
      "apps/platform/src/view.tsx": { legacy: 3 },
    },
  };
  assert.equal(baselineGrowthErrors(expanded, reference).length, 2);
});
