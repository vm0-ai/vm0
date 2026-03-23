import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/no-self-api-call.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-self-api-call", rule, {
  valid: [
    {
      // Importing something else from infra-client is fine
      code: 'import { forwardInfra } from "../../src/lib/infra-client";',
    },
    {
      // Importing createInfraClient from a different module is fine
      code: 'import { createInfraClient } from "some-other-package";',
    },
    {
      // Regular fetch usage is fine
      code: 'const res = await fetch("https://external-api.com/data");',
    },
    {
      // Non-infra-client imports are fine
      code: 'import { initServices } from "../../src/lib/init-services";',
    },
  ],
  invalid: [
    {
      code: 'import { createInfraClient } from "../../src/lib/infra-client";',
      errors: [
        {
          messageId: "noSelfApiCall",
          data: { name: "createInfraClient" },
        },
      ],
    },
    {
      code: 'import { proxyToInfra } from "../../../src/lib/infra-client";',
      errors: [
        {
          messageId: "noSelfApiCall",
          data: { name: "proxyToInfra" },
        },
      ],
    },
    {
      code: 'import { createInfraClient, forwardInfra, proxyToInfra } from "../../src/lib/infra-client";',
      errors: [
        {
          messageId: "noSelfApiCall",
          data: { name: "createInfraClient, proxyToInfra" },
        },
      ],
    },
  ],
});
