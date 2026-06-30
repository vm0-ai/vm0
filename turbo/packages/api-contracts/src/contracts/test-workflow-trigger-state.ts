import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testWorkflowTriggerStateActionBodySchema = z
  .object({
    action: z.enum([
      "seed-scenario",
      "delete-scenario",
      "seed-trigger",
      "seed-gmail-authorization",
      "set-owner-timezone",
      "seed-active-run",
      "get-trigger",
      "get-run-state",
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
