import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { noLoggerInfo } from "../rules/no-logger-info.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-logger-info", noLoggerInfo, {
  valid: [
    {
      code: 'const L = logger("Server"); L.debug("started");',
    },
    {
      code: 'logger("Server").warn("slow request");',
    },
    {
      code: 'client.info("metadata");',
    },
    {
      filename: "/app/src/__tests__/log.test.ts",
      code: 'const L = logger("Test"); L.info("test-only");',
    },
  ],
  invalid: [
    {
      code: 'logger("Server").info("started");',
      errors: [{ messageId: "noLoggerInfo" }],
    },
    {
      code: 'const L = logger("Server"); L.info("started");',
      errors: [{ messageId: "noLoggerInfo" }],
    },
  ],
});
