import { z } from "zod";

import { initContract } from "./base";
import { cronBrowserReconcileResponseSchema } from "./cron";

const c = initContract();

export const testBrowserReconcileBodySchema = z.object({
  chat_thread_ids: z.array(z.uuid()).min(1).max(20),
});

export const testBrowserReconcileContract = c.router({
  reconcile: {
    method: "POST",
    path: "/api/test/reconcile-browser-fixtures",
    body: testBrowserReconcileBodySchema,
    responses: {
      200: cronBrowserReconcileResponseSchema,
      404: z.string(),
    },
    summary: "Reconcile explicit managed-browser test fixtures",
  },
});

export type TestBrowserReconcileBody = z.infer<
  typeof testBrowserReconcileBodySchema
>;
export type TestBrowserReconcileContract = typeof testBrowserReconcileContract;
