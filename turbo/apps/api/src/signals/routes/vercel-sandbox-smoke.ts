import { initContract } from "@ts-rest/core";
import { command } from "ccstate";
import { z } from "zod";

import type { RouteEntry } from "../route";
import {
  runVercelSandboxSmoke,
  type VercelSandboxSmokeResult,
} from "../services/vercel-sandbox-smoke.service";
import { cronUnauthorized, hasValidCronSecret } from "./cron-auth";

const c = initContract();

const smokeErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
});

const smokeSandboxSchema = z.object({
  id: z.string(),
  runtime: z.literal("node24"),
});

const smokeCommandSchema = z.object({
  cmd: z.string(),
  args: z.array(z.string()),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

const smokeCheckNameSchema = z.enum(["node", "cli-auth-stripe"]);

const smokeCheckSchema = z.object({
  name: smokeCheckNameSchema,
  sandbox: smokeSandboxSchema,
  command: smokeCommandSchema,
  cleanup: z.object({ status: z.literal("stopped") }),
});

const smokeCleanupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stopped") }),
  z.object({
    status: z.literal("failed"),
    error: smokeErrorSchema,
  }),
]);

const smokeFailureSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.literal("VERCEL_SANDBOX_SMOKE_FAILED"),
    phase: z.enum(["create", "run", "cleanup"]),
    check: smokeCheckNameSchema,
    cause: smokeErrorSchema,
  }),
  checks: z.array(smokeCheckSchema),
  sandbox: smokeSandboxSchema.optional(),
  command: smokeCommandSchema.optional(),
  cleanup: smokeCleanupSchema.optional(),
});

const unauthorizedSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.literal("UNAUTHORIZED"),
  }),
});

export const vercelSandboxSmokeContract = c.router({
  smoke: {
    method: "POST",
    path: "/api/internal/vercel-sandbox/smoke",
    body: c.noBody(),
    headers: z.object({
      authorization: z.string().optional(),
    }),
    responses: {
      200: z.object({
        success: z.literal(true),
        checks: z.array(smokeCheckSchema),
      }),
      401: unauthorizedSchema,
      503: smokeFailureSchema,
    },
    summary: "Run a fixed Vercel Sandbox smoke check",
  },
});

function failureMessage(
  result: Extract<VercelSandboxSmokeResult, { ok: false }>,
) {
  switch (result.phase) {
    case "create": {
      return `${result.checkName} Vercel Sandbox smoke check failed during sandbox creation`;
    }
    case "run": {
      return `${result.checkName} Vercel Sandbox smoke check failed during command execution`;
    }
    case "cleanup": {
      return `${result.checkName} Vercel Sandbox smoke check failed during sandbox cleanup`;
    }
  }
}

const vercelSandboxSmokeRoute$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!hasValidCronSecret(get)) {
      return cronUnauthorized();
    }

    const result = await runVercelSandboxSmoke(signal);
    if (result.ok) {
      return {
        status: 200 as const,
        body: {
          success: true as const,
          checks: result.checks,
        },
      };
    }

    return {
      status: 503 as const,
      body: {
        error: {
          message: failureMessage(result),
          code: "VERCEL_SANDBOX_SMOKE_FAILED" as const,
          phase: result.phase,
          check: result.checkName,
          cause: result.error,
        },
        checks: result.checks,
        ...(result.sandbox ? { sandbox: result.sandbox } : {}),
        ...(result.command ? { command: result.command } : {}),
        ...(result.cleanup ? { cleanup: result.cleanup } : {}),
      },
    };
  },
);

export const vercelSandboxSmokeRoutes: readonly RouteEntry[] = [
  {
    route: vercelSandboxSmokeContract.smoke,
    handler: vercelSandboxSmokeRoute$,
  },
];
