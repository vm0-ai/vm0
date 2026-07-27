import { RuleTester } from "@typescript-eslint/rule-tester";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";

import { preferDrizzleQueryBuilder } from "../rules/prefer-drizzle-query-builder.ts";
import { queryBuilderWriteCases } from "./drizzle-query-builder-cases.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const dbPackageRoot = fileURLToPath(
  new URL("../../../../db/", import.meta.url),
);
const ruleTester = new RuleTester({
  defaultFilenames: {
    ts: `${dbPackageRoot}rule-test.ts`,
    tsx: `${dbPackageRoot}rule-test.tsx`,
  },
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ["rule-test.ts", "rule-test.tsx"],
      },
      tsconfigRootDir: dbPackageRoot,
    },
  },
});

ruleTester.run(
  "prefer-drizzle-query-builder writes",
  preferDrizzleQueryBuilder,
  queryBuilderWriteCases,
);
