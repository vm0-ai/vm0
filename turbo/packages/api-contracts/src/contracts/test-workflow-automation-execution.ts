import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testWorkflowAutomationExecutionRequestSchema = z.object({
  automation_id: z.string().uuid(),
});

export const testWorkflowAutomationExecutionResponseSchema = z.object({
  success: z.literal(true),
  executed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const testWorkflowAutomationExecutionContract = c.router({
  execute: {
    method: "POST",
    path: "/api/test/workflow-automation-execution/execute",
    body: testWorkflowAutomationExecutionRequestSchema,
    responses: {
      200: testWorkflowAutomationExecutionResponseSchema,
      404: z.string(),
    },
    summary: "Execute one workflow automation in API tests",
  },
});

export type TestWorkflowAutomationExecutionRequest = z.infer<
  typeof testWorkflowAutomationExecutionRequestSchema
>;
export type TestWorkflowAutomationExecutionResponse = z.infer<
  typeof testWorkflowAutomationExecutionResponseSchema
>;
export type TestWorkflowAutomationExecutionContract =
  typeof testWorkflowAutomationExecutionContract;
