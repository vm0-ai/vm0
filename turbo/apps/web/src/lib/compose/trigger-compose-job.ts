import crypto from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { composeJobs } from "../../db/schema/compose-job";
import type { ComposeJobSource } from "../../db/schema/compose-job";
import { cliTokens } from "../../db/schema/cli-tokens";
import { generateComposeJobToken } from "../auth/sandbox-token";
import { Sandbox } from "@e2b/code-interpreter";
import { env } from "../../env";
import { e2bConfig } from "../e2b/config";
import { logger } from "../logger";
import { notifySlackComposeComplete } from "../slack/handlers/compose-notification";

const log = logger("compose:trigger");

/**
 * Get API URL for sandbox to call back.
 * Falls back based on environment: preview -> production -> localhost.
 */
function getApiUrl(): string {
  const vercelEnv = env().VERCEL_ENV;
  const vercelUrl = env().VERCEL_URL;

  let apiUrl = env().VM0_API_URL;
  if (!apiUrl) {
    if (vercelEnv === "preview" && vercelUrl) {
      apiUrl = `https://${vercelUrl}`;
    } else if (vercelEnv === "production") {
      apiUrl = "https://www.vm0.ai";
    } else {
      apiUrl = "http://localhost:3000";
    }
  }

  return apiUrl;
}

/**
 * Inline sandbox script for compose jobs.
 *
 * This script runs in E2B sandbox and:
 * 1. Determines compose mode (github URL or platform content)
 * 2. Executes `vm0 compose <target> --json`
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
const COMPOSE_MODE = process.env.VM0_COMPOSE_MODE || 'github';
const GITHUB_URL = process.env.VM0_GITHUB_URL || '';
const COMPOSE_FILE = process.env.VM0_COMPOSE_FILE || '';
const VM0_TOKEN = process.env.VM0_TOKEN || '';
const VM0_API_URL = process.env.VM0_API_URL || '';
const WEBHOOK_URL = process.env.VM0_WEBHOOK_URL || '';
const WEBHOOK_TOKEN = process.env.VM0_WEBHOOK_TOKEN || '';
const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS || '';

function log(level, msg) {
  const ts = new Date().toISOString();
  console.error('[' + ts + '] [' + level + '] [compose-job] ' + msg);
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
  log('INFO', 'Starting compose job: ' + JOB_ID + ' (mode: ' + COMPOSE_MODE + ')');

  // Validate common environment variables
  if (!JOB_ID || !VM0_TOKEN || !VM0_API_URL || !WEBHOOK_URL || !WEBHOOK_TOKEN) {
    await reportCompletion(false, null, 'Missing required environment variables');
    process.exit(1);
  }

  // Determine compose target based on mode
  let composeTarget;
  if (COMPOSE_MODE === 'github') {
    if (!GITHUB_URL) {
      await reportCompletion(false, null, 'Missing GitHub URL');
      process.exit(1);
    }
    log('INFO', 'GitHub URL: ' + GITHUB_URL);
    composeTarget = GITHUB_URL;
  } else {
    if (!COMPOSE_FILE) {
      await reportCompletion(false, null, 'Missing compose file path');
      process.exit(1);
    }
    log('INFO', 'Compose file: ' + COMPOSE_FILE);
    composeTarget = COMPOSE_FILE;
  }

  // Execute vm0 compose with --json for structured output
  // CLI is pre-installed in the vm0-cli template
  log('INFO', 'Running vm0 compose...');
  const result = spawnSync('vm0', [
    'compose',
    composeTarget,
    '--json',
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
 * Extract instructions filename from compose content.
 * Looks for the `instructions` field in the first agent's config.
 */
function getInstructionsFilename(
  content: Record<string, unknown>,
): string | undefined {
  const agents = content.agents as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!agents) return undefined;
  const agentName = Object.keys(agents)[0];
  if (!agentName) return undefined;
  return agents[agentName]?.instructions as string | undefined;
}

/**
 * Compose job sandbox parameters
 */
type SandboxComposeParams =
  | { mode: "github"; githubUrl: string }
  | {
      mode: "platform";
      content: Record<string, unknown>;
      instructions?: string;
    };

/**
 * Spawn E2B sandbox for compose job (fire-and-forget)
 */
async function spawnComposeJobSandbox(
  jobId: string,
  params: SandboxComposeParams,
  cliToken: string,
  webhookToken: string,
  orgSlug: string,
): Promise<void> {
  const apiUrl = getApiUrl();
  const webhookUrl = `${apiUrl}/api/webhooks/compose/complete`;

  log.debug(`Creating sandbox for job ${jobId} (mode: ${params.mode})...`);

  // Build environment variables based on mode
  const sandboxEnvs: Record<string, string> = {
    VM0_JOB_ID: jobId,
    VM0_COMPOSE_MODE: params.mode,
    VM0_TOKEN: cliToken,
    VM0_API_URL: apiUrl,
    VM0_WEBHOOK_URL: webhookUrl,
    VM0_WEBHOOK_TOKEN: webhookToken,
    VM0_ACTIVE_ORG: orgSlug,
    ...(env().VERCEL_AUTOMATION_BYPASS_SECRET && {
      VERCEL_PROTECTION_BYPASS: env().VERCEL_AUTOMATION_BYPASS_SECRET,
    }),
  };

  if (params.mode === "github") {
    sandboxEnvs.VM0_GITHUB_URL = params.githubUrl;
  } else {
    sandboxEnvs.VM0_COMPOSE_FILE = "/tmp/compose/vm0.yaml";
  }

  const sandbox = await Sandbox.create(e2bConfig.cliTemplate, {
    timeoutMs: 5 * 60 * 1000,
    envs: sandboxEnvs,
  });

  log.debug(`Sandbox created: ${sandbox.sandboxId}`);

  await globalThis.services.db
    .update(composeJobs)
    .set({
      sandboxId: sandbox.sandboxId,
      status: "running",
      startedAt: new Date(),
    })
    .where(and(eq(composeJobs.id, jobId), eq(composeJobs.status, "pending")));

  // Write compose content files for platform mode
  if (params.mode === "platform") {
    const yamlContent = JSON.stringify(params.content, null, 2);
    await sandbox.files.write("/tmp/compose/vm0.yaml", yamlContent);

    // Write raw instructions file — metadata injection now happens at API
    // serve time (GET /api/agent/composes/:id/instructions), not at compose time.
    if (params.instructions !== undefined) {
      const instructionsFilename = getInstructionsFilename(params.content);
      if (instructionsFilename) {
        await sandbox.files.write(
          `/tmp/compose/${instructionsFilename}`,
          params.instructions,
        );
      }
    }
  }

  // Write and run the compose script
  const scriptPath = "/tmp/compose-job.js";
  await sandbox.files.write(scriptPath, COMPOSE_SANDBOX_SCRIPT);

  sandbox.commands
    .run(`node ${scriptPath}`, { timeoutMs: 5 * 60 * 1000 })
    .catch(async (error) => {
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

      const truncatedError = errorMessage.slice(0, 1000);
      // Wrap in try/catch to prevent unhandled rejection: this is already
      // inside a fire-and-forget .catch() handler, so a DB failure here
      // must not propagate as a second unhandled rejection.
      try {
        await globalThis.services.db
          .update(composeJobs)
          .set({
            status: "failed",
            error: truncatedError,
            completedAt: new Date(),
          })
          .where(eq(composeJobs.id, jobId));
      } catch (dbError) {
        log.error(`Failed to update job ${jobId} status to failed:`, dbError);
      }

      await notifySlackComposeComplete(jobId, null, truncatedError).catch(
        (notifyError) => {
          log.warn("Failed to send Slack failure notification", {
            notifyError,
          });
        },
      );
    });

  log.debug(`Compose script started for job ${jobId}`);
}

interface TriggerComposeJobResult {
  jobId: string;
  status: string;
  githubUrl: string | null;
  source: ComposeJobSource;
  createdAt: Date;
  isExisting: boolean;
}

/**
 * Generate a short-lived CLI token for sandbox use.
 * The token is stored in the cli_tokens table with a 10-minute TTL,
 * matching the compose-job webhook token lifetime.
 */
async function generateComposeCliToken(
  userId: string,
  jobId: string,
): Promise<string> {
  const token = `vm0_live_${crypto.randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await globalThis.services.db.insert(cliTokens).values({
    token,
    userId,
    name: `Compose Job ${jobId}`,
    expiresAt,
  });

  return token;
}

/**
 * Trigger a compose job from any source.
 * Reusable internal function callable from both the HTTP endpoint and Slack handler.
 *
 * Generates a short-lived CLI token server-side for sandbox authentication,
 * so callers don't need to provide a token.
 */
type TriggerComposeJobParams =
  | {
      userId: string;
      orgSlug: string;
      source: "github";
      githubUrl: string;
      overwrite?: boolean;
    }
  | {
      userId: string;
      orgSlug: string;
      source: "platform";
      content: Record<string, unknown>;
      instructions?: string;
    };

export async function triggerComposeJob(
  params: TriggerComposeJobParams,
): Promise<TriggerComposeJobResult> {
  const { userId, source, orgSlug } = params;

  // Atomic idempotency: INSERT with ON CONFLICT DO NOTHING against the
  // partial unique index (user_id WHERE status IN ('pending','running')).
  // If the insert succeeds, we get the new row back via RETURNING.
  // If a conflict occurs (active job already exists), RETURNING is empty.
  const jobId = crypto.randomUUID();
  const [newJob] = await globalThis.services.db
    .insert(composeJobs)
    .values({
      id: jobId,
      userId,
      source,
      status: "pending",
      ...(params.source === "github"
        ? { githubUrl: params.githubUrl, overwrite: params.overwrite ?? false }
        : { content: params.content, instructions: params.instructions }),
    })
    .onConflictDoNothing({
      target: composeJobs.userId,
      where: sql`status IN ('pending', 'running')`,
    })
    .returning();

  // Conflict: an active job already exists for this user
  if (!newJob) {
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

    // The active job may have completed between the INSERT conflict and this
    // SELECT (rare race). Fail fast instead of masking with non-null assertion.
    if (!existingJob) {
      throw new Error(
        `Active compose job not found for user ${userId} after insert conflict`,
      );
    }

    log.debug(`Returning existing job ${existingJob.id} for user ${userId}`);
    return {
      jobId: existingJob.id,
      status: existingJob.status,
      githubUrl: existingJob.githubUrl,
      source: existingJob.source,
      createdAt: existingJob.createdAt,
      isExisting: true,
    };
  }

  log.debug(`Created new job ${jobId} for user ${userId}`);

  // Generate tokens for sandbox
  const cliToken = await generateComposeCliToken(userId, jobId);
  const webhookToken = await generateComposeJobToken(userId, jobId);

  // Build sandbox params
  const sandboxParams: SandboxComposeParams =
    params.source === "github"
      ? { mode: "github", githubUrl: params.githubUrl }
      : {
          mode: "platform",
          content: params.content,
          instructions: params.instructions,
        };

  // Fire-and-forget: Spawn sandbox asynchronously
  spawnComposeJobSandbox(
    jobId,
    sandboxParams,
    cliToken,
    webhookToken,
    orgSlug,
  ).catch(async (error) => {
    log.error(`Failed to spawn sandbox for job ${jobId}:`, error);
    const errorMessage =
      error instanceof Error ? error.message : "Failed to create sandbox";
    // Wrap in try/catch to prevent unhandled rejection: this is already
    // inside a fire-and-forget .catch() handler, so a DB failure here
    // must not propagate as a second unhandled rejection.
    try {
      await globalThis.services.db
        .update(composeJobs)
        .set({
          status: "failed",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(composeJobs.id, jobId));
    } catch (dbError) {
      log.error(`Failed to update job ${jobId} status to failed:`, dbError);
    }

    await notifySlackComposeComplete(jobId, null, errorMessage).catch(
      (notifyError) => {
        log.warn("Failed to send Slack failure notification", {
          notifyError,
        });
      },
    );
  });

  return {
    jobId: newJob.id,
    status: "pending",
    githubUrl: newJob.githubUrl,
    source: newJob.source,
    createdAt: newJob.createdAt,
    isExisting: false,
  };
}
