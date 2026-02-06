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
 * 1. Downloads GitHub repository using git sparse-checkout
 * 2. Reads vm0.yaml content as string
 * 3. Sends yaml content to webhook for server-side parsing
 *
 * No external dependencies - uses only Node.js built-ins.
 */
const COMPOSE_SANDBOX_SCRIPT = `
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Environment variables
const JOB_ID = process.env.VM0_JOB_ID || '';
const GITHUB_URL = process.env.VM0_GITHUB_URL || '';
const API_TOKEN = process.env.VM0_API_TOKEN || '';
const WEBHOOK_URL = process.env.VM0_WEBHOOK_URL || '';
const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS || '';

const WORK_DIR = '/tmp/compose-github';

function log(level, msg) {
  const ts = new Date().toISOString();
  console.error('[' + ts + '] [' + level + '] [compose-github] ' + msg);
}

async function httpPost(url, data) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + API_TOKEN,
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

function parseGitHubUrl(url) {
  url = url.replace(/\\/$/, '');
  const match = url.match(/^https:\\/\\/github\\.com\\/([^/]+)\\/([^/]+)(?:\\/tree\\/([^/]+)(?:\\/(.+))?)?$/);
  if (!match) return null;
  return {
    owner: match[1] || '',
    repo: match[2] || '',
    branch: match[3] || 'main',
    path: match[4] || '',
  };
}

function downloadGitHubDirectory(info, destDir) {
  const repoUrl = 'https://github.com/' + info.owner + '/' + info.repo + '.git';
  try {
    fs.mkdirSync(destDir, { recursive: true });
    execSync('git init', { cwd: destDir, stdio: 'pipe' });
    execSync('git remote add origin ' + repoUrl, { cwd: destDir, stdio: 'pipe' });
    execSync('git config core.sparseCheckout true', { cwd: destDir, stdio: 'pipe' });

    const sparseDir = path.join(destDir, '.git/info');
    fs.mkdirSync(sparseDir, { recursive: true });
    fs.writeFileSync(path.join(sparseDir, 'sparse-checkout'), (info.path || '*') + '\\n');

    execSync('git fetch --depth=1 origin ' + info.branch, { cwd: destDir, stdio: 'pipe', timeout: 60000 });
    execSync('git checkout ' + info.branch, { cwd: destDir, stdio: 'pipe' });

    log('INFO', 'Downloaded from ' + repoUrl + ' (branch: ' + info.branch + ')');
    return true;
  } catch (error) {
    log('ERROR', 'Failed to download: ' + error.message);
    return false;
  }
}

function findVm0Yaml(baseDir, subPath) {
  const searchDir = subPath ? path.join(baseDir, subPath) : baseDir;

  for (const name of ['vm0.yaml', 'vm0.yml']) {
    const p = path.join(searchDir, name);
    if (fs.existsSync(p)) return p;
  }

  if (subPath) {
    for (const name of ['vm0.yaml', 'vm0.yml']) {
      const p = path.join(baseDir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

async function reportCompletion(success, yamlContent, error) {
  const payload = { jobId: JOB_ID, success };
  if (yamlContent) payload.yamlContent = yamlContent;
  if (error) payload.error = error;

  log('INFO', 'Reporting to ' + WEBHOOK_URL);
  const response = await httpPost(WEBHOOK_URL, payload);
  if (response) {
    log('INFO', 'Reported successfully');
  } else {
    log('ERROR', 'Failed to report');
  }
}

async function main() {
  log('INFO', 'Starting job: ' + JOB_ID);
  log('INFO', 'GitHub URL: ' + GITHUB_URL);

  // Validate
  if (!JOB_ID || !GITHUB_URL || !API_TOKEN || !WEBHOOK_URL) {
    await reportCompletion(false, null, 'Missing required environment variables');
    process.exit(1);
  }

  // Parse URL
  const gitInfo = parseGitHubUrl(GITHUB_URL);
  if (!gitInfo) {
    await reportCompletion(false, null, 'Invalid GitHub URL: ' + GITHUB_URL);
    process.exit(1);
  }

  log('INFO', 'Parsed: ' + gitInfo.owner + '/' + gitInfo.repo + ' branch=' + gitInfo.branch + ' path=' + (gitInfo.path || '(root)'));

  // Clean up
  if (fs.existsSync(WORK_DIR)) {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }

  // Download
  log('INFO', 'Downloading from GitHub...');
  if (!downloadGitHubDirectory(gitInfo, WORK_DIR)) {
    await reportCompletion(false, null, 'Failed to download from GitHub');
    process.exit(1);
  }

  // Find yaml
  log('INFO', 'Looking for vm0.yaml...');
  const yamlPath = findVm0Yaml(WORK_DIR, gitInfo.path);
  if (!yamlPath) {
    await reportCompletion(false, null, 'vm0.yaml not found in repository');
    process.exit(1);
  }

  log('INFO', 'Found: ' + yamlPath);

  // Read yaml content as string
  const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
  log('INFO', 'Read ' + yamlContent.length + ' bytes');

  // Send to webhook for server-side processing
  await reportCompletion(true, yamlContent, null);
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
  _overwrite: boolean,
  sandboxToken: string,
): Promise<void> {
  const apiUrl = getApiUrl();
  const webhookUrl = `${apiUrl}/api/webhooks/compose/complete`;

  log.debug(`Creating sandbox for job ${jobId}...`);

  // Create sandbox with 5-minute timeout
  const sandbox = await Sandbox.create(e2bConfig.defaultTemplate, {
    timeoutMs: 5 * 60 * 1000, // 5 minutes
    envs: {
      VM0_JOB_ID: jobId,
      VM0_GITHUB_URL: githubUrl,
      VM0_API_TOKEN: sandboxToken,
      VM0_WEBHOOK_URL: webhookUrl,
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

    // Generate sandbox token
    const sandboxToken = await generateComposeJobToken(userId, jobId);

    // Fire-and-forget: Spawn sandbox asynchronously
    spawnComposeJobSandbox(
      jobId,
      githubUrl,
      overwrite ?? false,
      sandboxToken,
    ).catch(async (error) => {
      log.error(`Failed to spawn sandbox for job ${jobId}:`, error);
      // Update job status to failed
      await globalThis.services.db
        .update(composeJobs)
        .set({
          status: "failed",
          error:
            error instanceof Error ? error.message : "Failed to create sandbox",
          completedAt: new Date(),
        })
        .where(eq(composeJobs.id, jobId));
    });

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
