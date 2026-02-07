import { and, eq, inArray } from "drizzle-orm";
import { composeJobs } from "../../db/schema/compose-job";
import { generateComposeJobToken } from "../auth/sandbox-token";
import { Sandbox } from "@e2b/code-interpreter";
import { e2bConfig } from "../e2b/config";
import { logger } from "../logger";
import { notifySlackComposeComplete } from "../slack/handlers/compose-notification";

const log = logger("compose:trigger");

/**
 * Get API URL for sandbox to call back.
 * Falls back based on environment: preview -> production -> localhost.
 */
function getApiUrl(): string {
  const envVars = globalThis.services?.env;
  const vercelEnv = process.env.VERCEL_ENV;
  const vercelUrl = process.env.VERCEL_URL;

  let apiUrl = envVars?.VM0_API_URL || process.env.VM0_API_URL;
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

  const sandbox = await Sandbox.create(e2bConfig.cliTemplate, {
    timeoutMs: 5 * 60 * 1000,
    envs: {
      VM0_JOB_ID: jobId,
      VM0_GITHUB_URL: githubUrl,
      VM0_TOKEN: userToken,
      VM0_API_URL: apiUrl,
      VM0_WEBHOOK_URL: webhookUrl,
      VM0_WEBHOOK_TOKEN: webhookToken,
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET && {
        VERCEL_PROTECTION_BYPASS: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      }),
    },
  });

  log.debug(`Sandbox created: ${sandbox.sandboxId}`);

  await globalThis.services.db
    .update(composeJobs)
    .set({
      sandboxId: sandbox.sandboxId,
      status: "running",
      startedAt: new Date(),
    })
    .where(eq(composeJobs.id, jobId));

  const scriptPath = "/tmp/compose-github.js";
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
      await globalThis.services.db
        .update(composeJobs)
        .set({
          status: "failed",
          error: truncatedError,
          completedAt: new Date(),
        })
        .where(eq(composeJobs.id, jobId));

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
  githubUrl: string;
  createdAt: Date;
  isExisting: boolean;
}

/**
 * Trigger a compose-from-github job.
 * Reusable internal function callable from both the HTTP endpoint and Slack handler.
 *
 * No Slack-specific parameters — pure compose domain.
 */
export async function triggerComposeJob(params: {
  userId: string;
  githubUrl: string;
  userToken: string;
  overwrite?: boolean;
}): Promise<TriggerComposeJobResult> {
  const { userId, githubUrl, userToken, overwrite = false } = params;

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
      jobId: existingJob.id,
      status: existingJob.status,
      githubUrl: existingJob.githubUrl,
      createdAt: existingJob.createdAt,
      isExisting: true,
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
      overwrite,
      status: "pending",
    })
    .returning();

  log.debug(`Created new job ${jobId} for user ${userId}`);

  // Generate webhook token
  const webhookToken = await generateComposeJobToken(userId, jobId);

  // Fire-and-forget: Spawn sandbox asynchronously
  spawnComposeJobSandbox(jobId, githubUrl, userToken, webhookToken).catch(
    async (error) => {
      log.error(`Failed to spawn sandbox for job ${jobId}:`, error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to create sandbox";
      await globalThis.services.db
        .update(composeJobs)
        .set({
          status: "failed",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(composeJobs.id, jobId));

      await notifySlackComposeComplete(jobId, null, errorMessage).catch(
        (notifyError) => {
          log.warn("Failed to send Slack failure notification", {
            notifyError,
          });
        },
      );
    },
  );

  return {
    jobId: newJob!.id,
    status: "pending",
    githubUrl: newJob!.githubUrl,
    createdAt: newJob!.createdAt,
    isExisting: false,
  };
}
