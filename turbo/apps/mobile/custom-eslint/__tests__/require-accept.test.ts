import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/require-accept.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const SIGNALS_FILE = "/app/src/signals/zero-page/billing.ts";
const TEST_FILE = "/app/src/signals/__tests__/billing.test.ts";
const VIEW_FILE = "/app/src/views/zero-page/billing-view.tsx";

ruleTester.run("require-accept", rule, {
  valid: [
    // Wrapped in accept() — variable client pattern
    {
      filename: SIGNALS_FILE,
      code: `
        const createClient = get(zeroClient$);
        const client = createClient(someContract);
        const result = await accept(client.get(), [200]);
      `,
    },
    // Wrapped in accept() — inline client pattern
    {
      filename: SIGNALS_FILE,
      code: `
        const result = await accept(get(zeroClient$)(someContract).list(), [200]);
      `,
    },
    // Accept with options
    {
      filename: SIGNALS_FILE,
      code: `
        const createClient = get(zeroClient$);
        const client = createClient(someContract);
        const result = await accept(client.create({ body }), [201], { toast: false });
      `,
    },
    // Test file — rule not applied
    {
      filename: TEST_FILE,
      code: `
        const createClient = get(zeroClient$);
        const client = createClient(someContract);
        const result = await client.get();
      `,
    },
    // Views file — rule not applied
    {
      filename: VIEW_FILE,
      code: `
        const result = await someClient.get();
      `,
    },
    // Non-zeroClient$ method call — not tracked
    {
      filename: SIGNALS_FILE,
      code: `
        const result = await someOtherService.fetch();
      `,
    },
    // Method call on non-client tracked object
    {
      filename: SIGNALS_FILE,
      code: `
        const logger = getLogger();
        logger.error("something");
      `,
    },
  ],
  invalid: [
    // Variable client, no accept
    {
      filename: SIGNALS_FILE,
      code: `
        const createClient = get(zeroClient$);
        const client = createClient(someContract);
        const result = await client.get();
      `,
      errors: [{ messageId: "requireAccept" }],
    },
    // Variable client, create method
    {
      filename: SIGNALS_FILE,
      code: `
        const createClient = get(zeroClient$);
        const client = createClient(someContract);
        await client.create({ body: { name: "test" } });
      `,
      errors: [{ messageId: "requireAccept" }],
    },
    // Inline client pattern, no accept
    {
      filename: SIGNALS_FILE,
      code: `
        const result = await get(zeroClient$)(someContract).list();
      `,
      errors: [{ messageId: "requireAccept" }],
    },
    // Factory then client, delete method
    {
      filename: SIGNALS_FILE,
      code: `
        const createClient = get(zeroClient$);
        const client = createClient(deleteContract);
        await client.delete({ params: { id: "123" } });
      `,
      errors: [{ messageId: "requireAccept" }],
    },
    // Multiple clients — second one unguarded
    {
      filename: SIGNALS_FILE,
      code: `
        const createClient = get(zeroClient$);
        const client1 = createClient(contractA);
        const client2 = createClient(contractB);
        const r1 = await accept(client1.get(), [200]);
        const r2 = await client2.update({ body });
      `,
      errors: [{ messageId: "requireAccept" }],
    },
  ],
});
