import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { composeJobsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { composeJobs } from "../../../../src/db/schema/compose-job";
import { and, eq, inArray } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { generateComposeJobToken } from "../../../../src/lib/auth/sandbox-token";
import { Sandbox } from "@e2b/code-interpreter";
import { e2bConfig } from "../../../../src/lib/e2b/config";
import { logger } from "../../../../src/lib/logger";
import type { ComposeJobResult } from "../../../../src/db/schema/compose-job";

const log = logger("api:compose-from-github");

/**
 * Get API URL for sandbox to call back.
 * Requires VM0_API_URL to be set, or VERCEL_URL in preview environments.
 */
function getApiUrl(): string {
  const envVars = globalThis.services?.env;
  const vercelEnv = process.env.VERCEL_ENV;
  const vercelUrl = process.env.VERCEL_URL;

  const apiUrl = envVars?.VM0_API_URL || process.env.VM0_API_URL;
  if (apiUrl) {
    return apiUrl;
  }

  // In Vercel preview deployments, derive URL from VERCEL_URL
  if (vercelEnv === "preview" && vercelUrl) {
    return `https://${vercelUrl}`;
  }

  throw new Error(
    "VM0_API_URL environment variable is required for compose job webhooks",
  );
}

/**
 * Format job record for API response
 */
function formatJobResponse(job: {
  id: string;
  status: string;
  githubUrl: string;
  result: ComposeJobResult | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}) {
  return {
    jobId: job.id,
    status: job.status as "pending" | "running" | "completed" | "failed",
    githubUrl: job.githubUrl,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString(),
    completedAt: job.completedAt?.toISOString(),
  };
}

/**
 * Inline sandbox script for compose-from-github.
 *
 * This script runs in E2B sandbox and:
 * 1. Installs vm0 CLI
 * 2. Executes `vm0 compose <github_url> --yes --experimental-shared-compose`
 * 3. Parses CLI output and sends result to webhook
 *
 * Using CLI ensures full feature parity including:
 * - Skills download and frontmatter parsing
 * - Automatic secrets/vars injection from skills
 * - Instructions file handling
 */
const COMPOSE_SANDBOX_SCRIPT = `
const { spawnSync } = require('child_process');

// Environment variables
const JOB_ID = process.env.VM0_JOB_ID || '';
const GITHUB_URL = process.env.VM0_GITHUB_URL || '';
const VM0_TOKEN = process.env.VM0_TOKEN || '';
const VM0_API_URL = process.env.VM0_API_URL || '';
const WEBHOOK_URL = process.env.VM0_WEBHOOK_URL || '';
const WEBHOOK_TOKEN = process.env.VM0_WEBHOOK_TOKEN || '';
const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS || '';

function log(level, msg) {
  const ts = new Date().toISOString();
  console.error('[' + ts + '] [' + level + '] [compose-github] ' + msg);
}

async function httpPost(url, data) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + WEBHOOK_TOKEN,
  };
  if (VERCEL_BYPASS) {
    headers['x-vercel-protection-bypass'] = VERCEL_BYPASS;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
      });

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : {};
      }

      const errorText = await response.text().catch(() => '');
      log('WARN', 'HTTP POST failed (attempt ' + attempt + '/3): HTTP ' + response.status + ' - ' + errorText);
    } catch (error) {
      log('WARN', 'HTTP POST failed (attempt ' + attempt + '/3): ' + error.message);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

async function reportCompletion(success, result, error) {
  const payload = { jobId: JOB_ID, success };
  if (result) payload.result = result;
  if (error) payload.error = error;

  log('INFO', 'Reporting to webhook...');
  const response = await httpPost(WEBHOOK_URL, payload);
  if (response) {
    log('INFO', 'Reported successfully');
  } else {
    log('ERROR', 'Failed to report to webhook');
  }
}

async function main() {
  log('INFO', 'Starting compose job: ' + JOB_ID);
  log('INFO', 'GitHub URL: ' + GITHUB_URL);
  log('INFO', 'API URL: ' + VM0_API_URL);

  // Validate
  if (!JOB_ID || !GITHUB_URL || !VM0_TOKEN || !VM0_API_URL || !WEBHOOK_URL || !WEBHOOK_TOKEN) {
    await reportCompletion(false, null, 'Missing required environment variables');
    process.exit(1);
  }

  // Execute vm0 compose with --porcelain for structured output
  // CLI is pre-installed in the vm0-cli template
  log('INFO', 'Running vm0 compose...');
  const result = spawnSync('vm0', [
    'compose',
    GITHUB_URL,
    '--experimental-shared-compose',
    '--porcelain',
  ], {
    env: {
      ...process.env,
      VM0_TOKEN: VM0_TOKEN,
      VM0_API_URL: VM0_API_URL,
    },
    encoding: 'utf-8',
    timeout: 180000, // 3 minutes
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  log('INFO', 'CLI exit code: ' + result.status);
  if (stderr) log('INFO', 'stderr: ' + stderr);

  // Parse JSON output from CLI
  let cliResult;
  try {
    cliResult = JSON.parse(stdout.trim());
  } catch (parseError) {
    log('ERROR', 'Failed to parse CLI JSON output: ' + stdout);
    await reportCompletion(false, null, 'Failed to parse CLI output: ' + stdout.slice(0, 200));
    process.exit(1);
  }

  // Check for error in CLI output
  if (cliResult.error) {
    log('ERROR', 'CLI error: ' + cliResult.error);
    await reportCompletion(false, null, cliResult.error);
    process.exit(1);
  }

  // Report success with structured result
  log('INFO', 'Compose result: ' + JSON.stringify(cliResult));
  await reportCompletion(true, {
    composeId: cliResult.composeId,
    composeName: cliResult.composeName,
    versionId: cliResult.versionId,
    warnings: [],
  }, null);

  log('INFO', 'Done!');
}

main().catch(async (error) => {
  log('ERROR', 'Fatal: ' + error.message);
  await reportCompletion(false, null, error.message);
  process.exit(1);
});
`;

/**
 * Spawn E2B sandbox for compose job (fire-and-forget)
 *
 * @param jobId - The compose job ID
 * @param githubUrl - GitHub URL to compose from
 * @param userToken - User's CLI token for API authentication
 * @param webhookToken - Short-lived token for webhook callback
 */
async function spawnComposeJobSandbox(
  jobId: string,
  githubUrl: string,
  userToken: string,
  webhookToken: string,
): Promise<void> {
  const apiUrl = getApiUrl();
  const webhookUrl = `${apiUrl}/api/webhooks/compose/complete`;

  log.debug(`Creating sandbox for job ${jobId}...`);

  // Create sandbox with 5-minute timeout
  // Use vm0-cli template which has CLI pre-installed for faster execution
  const sandbox = await Sandbox.create(e2bConfig.cliTemplate, {
    timeoutMs: 5 * 60 * 1000, // 5 minutes
    envs: {
      VM0_JOB_ID: jobId,
      VM0_GITHUB_URL: githubUrl,
      VM0_TOKEN: userToken, // User's real token for CLI
      VM0_API_URL: apiUrl,
      VM0_WEBHOOK_URL: webhookUrl,
      VM0_WEBHOOK_TOKEN: webhookToken, // Short-lived token for webhook
      // Add Vercel protection bypass if available
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET && {
        VERCEL_PROTECTION_BYPASS: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      }),
    },
  });

  log.debug(`Sandbox created: ${sandbox.sandboxId}`);

  // Update job with sandbox ID and set status to running
  await globalThis.services.db
    .update(composeJobs)
    .set({
      sandboxId: sandbox.sandboxId,
      status: "running",
      startedAt: new Date(),
    })
    .where(eq(composeJobs.id, jobId));

  // Write and run inline script
  const scriptPath = "/tmp/compose-github.js";
  await sandbox.files.write(scriptPath, COMPOSE_SANDBOX_SCRIPT);

  // Run in background - don't await
  sandbox.commands
    .run(`node ${scriptPath}`, { timeoutMs: 5 * 60 * 1000 })
    .catch(async (error) => {
      // Extract detailed error info from E2B command result
      const errorResult = error as {
        result?: { stdout?: string; stderr?: string };
      };
      const stdout = errorResult.result?.stdout || "";
      const stderr = errorResult.result?.stderr || "";
      const errorMessage =
        stderr ||
        stdout ||
        (error instanceof Error ? error.message : "Unknown error");

      log.error(`Sandbox script failed for job ${jobId}:`);
      log.error(`  stdout: ${stdout}`);
      log.error(`  stderr: ${stderr}`);

      // Update job status to failed since webhook won't be called
      await globalThis.services.db
        .update(composeJobs)
        .set({
          status: "failed",
          error: errorMessage.slice(0, 1000), // Limit error length
          completedAt: new Date(),
        })
        .where(eq(composeJobs.id, jobId));
    });

  log.debug(`Compose script started for job ${jobId}`);
}

const router = tsr.router(composeJobsMainContract, {
  create: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const { githubUrl, overwrite } = body;

    // Idempotency: Check for existing active job for this user
    const [existingJob] = await globalThis.services.db
      .select()
      .from(composeJobs)
      .where(
        and(
          eq(composeJobs.userId, userId),
          inArray(composeJobs.status, ["pending", "running"]),
        ),
      )
      .limit(1);

    if (existingJob) {
      log.debug(`Returning existing job ${existingJob.id} for user ${userId}`);
      return {
        status: 200 as const,
        body: formatJobResponse(existingJob),
      };
    }

    // Create new job
    const jobId = crypto.randomUUID();
    const [newJob] = await globalThis.services.db
      .insert(composeJobs)
      .values({
        id: jobId,
        userId,
        githubUrl,
        overwrite: overwrite ?? false,
        status: "pending",
      })
      .returning();

    log.debug(`Created new job ${jobId} for user ${userId}`);

    // Extract user token from Authorization header
    const userToken = headers.authorization?.substring(7); // Remove "Bearer "
    if (!userToken) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Missing authorization token",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    // Generate webhook token (short-lived, for callback only)
    const webhookToken = await generateComposeJobToken(userId, jobId);

    // Fire-and-forget: Spawn sandbox asynchronously
    spawnComposeJobSandbox(jobId, githubUrl, userToken, webhookToken).catch(
      async (error) => {
        log.error(`Failed to spawn sandbox for job ${jobId}:`, error);
        // Update job status to failed
        await globalThis.services.db
          .update(composeJobs)
          .set({
            status: "failed",
            error:
              error instanceof Error
                ? error.message
                : "Failed to create sandbox",
            completedAt: new Date(),
          })
          .where(eq(composeJobs.id, jobId));
      },
    );

    return {
      status: 201 as const,
      body: formatJobResponse(newJob!),
    };
  },
});

/**
 * Custom error handler
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(composeJobsMainContract, router, {
  errorHandler,
});

export { handler as POST };
