import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testWorkflowTriggerStateActionBodySchema = z
  .object({
    action: z.enum([
      "seed-scenario",
      "delete-scenario",
      "seed-workflows-fixture",
      "seed-agent-workflow",
      "seed-workflow",
      "seed-workflow-storage",
      "seed-instructions-storage",
      "seed-trigger",
      "seed-connector",
      "seed-gmail-authorization",
      "seed-github-installation",
      "seed-github-user-link",
      "set-owner-timezone",
      "set-agent-visibility",
      "seed-active-run",
      "set-trigger-run-state",
      "get-trigger",
      "get-run-state",
      "get-workflow-state",
      "get-gmail-watch",
      "get-google-calendar-watch",
      "get-chat-thread",
      "get-github-processed-events",
    ]),
  })
  .passthrough();

export const testWorkflowTriggerStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testWorkflowTriggerStateErrorSchema = z.object({
  error: z.string(),
});

export const testWorkflowTriggerStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/workflow-trigger-state/action",
    body: testWorkflowTriggerStateActionBodySchema,
    responses: {
      200: testWorkflowTriggerStateActionResponseSchema,
      400: testWorkflowTriggerStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate or inspect workflow trigger test state",
  },
});

export type TestWorkflowTriggerStateActionBody = z.infer<
  typeof testWorkflowTriggerStateActionBodySchema
>;
export type TestWorkflowTriggerStateActionResponse = z.infer<
  typeof testWorkflowTriggerStateActionResponseSchema
>;
export type TestWorkflowTriggerStateContract =
  typeof testWorkflowTriggerStateContract;
