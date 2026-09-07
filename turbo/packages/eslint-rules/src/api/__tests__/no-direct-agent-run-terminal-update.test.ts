import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noDirectAgentRunTerminalUpdate } from "../rules/no-direct-agent-run-terminal-update.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const agentRunSchemaModule = "@okouai" + "/db/schema/agent-run";
const preamble = `
  import { agentRuns } from "${agentRunSchemaModule}";
  declare const tx: {
    update(table: unknown): {
      set(values: unknown): unknown;
    };
  };
`;

ruleTester.run(
  "no-direct-agent-run-terminal-update",
  noDirectAgentRunTerminalUpdate,
  {
    valid: [
      {
        name: "active transition remains direct",
        code: `${preamble}
          tx.update(agentRuns).set({ status: "pending" });
        `,
      },
      {
        name: "non-status Agent run update remains direct",
        code: `${preamble}
          tx.update(agentRuns).set({ lastHeartbeatAt: new Date(0) });
        `,
      },
      {
        name: "local non-status Agent run update remains direct",
        code: `${preamble}
          const values = {
            ...(true ? { lastHeartbeatAt: new Date(0) } : {}),
          };
          tx.update(agentRuns).set(values);
        `,
      },
      {
        name: "terminal status on another table is unrelated",
        code: `${preamble}
          const jobs = {};
          tx.update(jobs).set({ status: "failed" });
        `,
      },
    ],
    invalid: [
      ...["completed", "failed", "timeout", "cancelled"].map((status) => {
        return {
          name: `direct ${status} transition is rejected`,
          code: `${preamble}
            tx.update(agentRuns).set({ status: "${status}" });
          `,
          errors: [{ messageId: "directTerminalUpdate" as const }],
        };
      }),
      {
        name: "dynamic status transition is rejected",
        code: `${preamble}
          declare const status: "completed" | "failed";
          tx.update(agentRuns).set({ status });
        `,
        errors: [{ messageId: "directTerminalUpdate" }],
      },
      {
        name: "opaque update values are rejected",
        code: `${preamble}
          declare const values: { status?: "failed" };
          tx.update(agentRuns).set(values);
        `,
        errors: [{ messageId: "directTerminalUpdate" }],
      },
      {
        name: "computed update property is rejected",
        code: `${preamble}
          declare const key: "status";
          tx.update(agentRuns).set({ [key]: "failed" });
        `,
        errors: [{ messageId: "directTerminalUpdate" }],
      },
      {
        name: "spread update argument is rejected",
        code: `${preamble}
          declare const values: [{ status: "failed" }];
          tx.update(agentRuns).set(...values);
        `,
        errors: [{ messageId: "directTerminalUpdate" }],
      },
      {
        name: "aliased table and values are rejected",
        code: `
          import { agentRuns as runs } from "${agentRunSchemaModule}";
          declare const tx: {
            update(table: unknown): {
              set(values: unknown): unknown;
            };
          };
          const values = { status: "failed" };
          tx.update(runs).set(values);
        `,
        errors: [{ messageId: "directTerminalUpdate" }],
      },
      {
        name: "terminal status in a local spread is rejected",
        code: `${preamble}
          const terminal = { status: "timeout" };
          tx.update(agentRuns).set({ completedAt: new Date(0), ...terminal });
        `,
        errors: [{ messageId: "directTerminalUpdate" }],
      },
    ],
  },
);
