/**
 * Compose GitHub script for E2B sandbox.
 * Downloads a GitHub directory and creates an agent compose from vm0.yaml.
 *
 * Environment variables:
 * - VM0_JOB_ID: Compose job ID
 * - VM0_GITHUB_URL: GitHub URL (directory or repository)
 * - VM0_OVERWRITE: Whether to overwrite existing compose
 * - VM0_API_URL: API base URL
 * - VM0_API_TOKEN: JWT token for authentication
 * - VM0_WEBHOOK_URL: Webhook URL for completion callback
 * - VERCEL_PROTECTION_BYPASS: Optional Vercel bypass token
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as yaml from "yaml";

// Environment variables (separate from agent scripts)
const JOB_ID = process.env.VM0_JOB_ID ?? "";
const GITHUB_URL = process.env.VM0_GITHUB_URL ?? "";
const OVERWRITE = process.env.VM0_OVERWRITE === "true";
const API_URL = process.env.VM0_API_URL ?? "";
const API_TOKEN = process.env.VM0_API_TOKEN ?? "";
const WEBHOOK_URL = process.env.VM0_WEBHOOK_URL ?? "";
const VERCEL_BYPASS = process.env.VERCEL_PROTECTION_BYPASS ?? "";

// HTTP configuration
const HTTP_MAX_TIME = 60;
const HTTP_MAX_RETRIES = 3;

// Working directory
const WORK_DIR = "/tmp/compose-github";

// Logging functions
function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function logInfo(msg: string): void {
  console.error(`[${timestamp()}] [INFO] [compose-github] ${msg}`);
}

function logError(msg: string): void {
  console.error(`[${timestamp()}] [ERROR] [compose-github] ${msg}`);
}

function logWarn(msg: string): void {
  console.error(`[${timestamp()}] [WARN] [compose-github] ${msg}`);
}

/**
 * Sleep for given milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP POST with JSON body and retry logic.
 */
async function httpPostJson(
  url: string,
  data: Record<string, unknown>,
  maxRetries: number = HTTP_MAX_RETRIES,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_TOKEN}`,
  };
  if (VERCEL_BYPASS) {
    headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        HTTP_MAX_TIME * 1000,
      );

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const text = await response.text();
        if (text) {
          return JSON.parse(text) as Record<string, unknown>;
        }
        return {};
      }

      const errorText = await response.text().catch(() => "");
      logWarn(
        `HTTP POST failed (attempt ${attempt}/${maxRetries}): HTTP ${response.status} - ${errorText}`,
      );
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logWarn(
        `HTTP POST failed (attempt ${attempt}/${maxRetries}): ${errorMsg}`,
      );
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    }
  }

  logError(`HTTP POST failed after ${maxRetries} attempts to ${url}`);
  return null;
}

/**
 * Parse GitHub URL to extract owner, repo, branch, and path.
 * Supports URLs like:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch
 * - https://github.com/owner/repo/tree/branch/path/to/dir
 */
interface GitHubInfo {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

function parseGitHubUrl(url: string): GitHubInfo | null {
  // Remove trailing slash
  url = url.replace(/\/$/, "");

  // Match GitHub URL pattern
  const match = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/,
  );

  if (!match) {
    return null;
  }

  return {
    owner: match[1] ?? "",
    repo: match[2] ?? "",
    branch: match[3] ?? "main",
    path: match[4] ?? "",
  };
}

/**
 * Download GitHub directory using git sparse-checkout.
 */
function downloadGitHubDirectory(info: GitHubInfo, destDir: string): boolean {
  const repoUrl = `https://github.com/${info.owner}/${info.repo}.git`;

  try {
    // Create destination directory
    fs.mkdirSync(destDir, { recursive: true });

    // Initialize git repo with sparse checkout
    execSync("git init", { cwd: destDir, stdio: "pipe" });
    execSync(`git remote add origin ${repoUrl}`, {
      cwd: destDir,
      stdio: "pipe",
    });
    execSync("git config core.sparseCheckout true", {
      cwd: destDir,
      stdio: "pipe",
    });

    // Configure sparse checkout pattern
    const sparseCheckoutDir = path.join(destDir, ".git/info");
    fs.mkdirSync(sparseCheckoutDir, { recursive: true });
    const pattern = info.path || "*";
    fs.writeFileSync(
      path.join(sparseCheckoutDir, "sparse-checkout"),
      pattern + "\n",
    );

    // Fetch and checkout
    execSync(`git fetch --depth=1 origin ${info.branch}`, {
      cwd: destDir,
      stdio: "pipe",
      timeout: 60000,
    });
    execSync(`git checkout ${info.branch}`, { cwd: destDir, stdio: "pipe" });

    logInfo(`Successfully downloaded from ${repoUrl} (branch: ${info.branch})`);
    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError(`Failed to download from GitHub: ${errorMsg}`);
    return false;
  }
}

/**
 * Find vm0.yaml in the downloaded directory.
 */
function findVm0Yaml(baseDir: string, subPath: string): string | null {
  // If subPath is specified, look in that directory
  const searchDir = subPath ? path.join(baseDir, subPath) : baseDir;

  const yamlPath = path.join(searchDir, "vm0.yaml");
  if (fs.existsSync(yamlPath)) {
    return yamlPath;
  }

  const ymlPath = path.join(searchDir, "vm0.yml");
  if (fs.existsSync(ymlPath)) {
    return ymlPath;
  }

  // If not in subPath, try the root
  if (subPath) {
    const rootYamlPath = path.join(baseDir, "vm0.yaml");
    if (fs.existsSync(rootYamlPath)) {
      return rootYamlPath;
    }

    const rootYmlPath = path.join(baseDir, "vm0.yml");
    if (fs.existsSync(rootYmlPath)) {
      return rootYmlPath;
    }
  }

  return null;
}

/**
 * Read and parse vm0.yaml file.
 */
function readVm0Yaml(yamlPath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(yamlPath, "utf-8");
    return yaml.parse(content) as Record<string, unknown>;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError(`Failed to parse vm0.yaml: ${errorMsg}`);
    return null;
  }
}

/**
 * Create agent compose via API.
 */
interface CreateComposeResult {
  composeId: string;
  composeName: string;
  versionId: string;
  warnings: string[];
}

async function createCompose(
  content: Record<string, unknown>,
): Promise<CreateComposeResult | null> {
  const url = `${API_URL}/api/agent/composes`;

  const result = await httpPostJson(url, { content });
  if (!result) {
    return null;
  }

  // Check for error response
  if (result.error) {
    const errorObj = result.error as { message?: string };
    logError(`Compose creation failed: ${errorObj.message ?? "Unknown error"}`);
    return null;
  }

  const composeId = result.composeId as string;
  const composeName = result.name as string;
  const versionId = result.versionId as string;

  if (!composeId || !versionId) {
    logError(`Invalid compose response: ${JSON.stringify(result)}`);
    return null;
  }

  return {
    composeId,
    composeName,
    versionId,
    warnings: [],
  };
}

/**
 * Call webhook to report completion.
 */
async function reportCompletion(
  success: boolean,
  result?: CreateComposeResult,
  error?: string,
): Promise<void> {
  const payload: Record<string, unknown> = {
    jobId: JOB_ID,
    success,
  };

  if (result) {
    payload.result = {
      composeId: result.composeId,
      composeName: result.composeName,
      versionId: result.versionId,
      warnings: result.warnings,
    };
  }

  if (error) {
    payload.error = error;
  }

  logInfo(`Reporting completion to ${WEBHOOK_URL}`);
  const response = await httpPostJson(WEBHOOK_URL, payload);

  if (response) {
    logInfo("Completion reported successfully");
  } else {
    logError("Failed to report completion");
  }
}

/**
 * Validate required environment variables.
 */
function validateConfig(): boolean {
  const required = [
    ["VM0_JOB_ID", JOB_ID],
    ["VM0_GITHUB_URL", GITHUB_URL],
    ["VM0_API_URL", API_URL],
    ["VM0_API_TOKEN", API_TOKEN],
    ["VM0_WEBHOOK_URL", WEBHOOK_URL],
  ];

  for (const [name, value] of required) {
    if (!value) {
      logError(`Missing required environment variable: ${name}`);
      return false;
    }
  }

  return true;
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  logInfo(`Starting compose from GitHub job: ${JOB_ID}`);
  logInfo(`GitHub URL: ${GITHUB_URL}`);
  logInfo(`Overwrite: ${OVERWRITE}`);

  // Validate configuration
  if (!validateConfig()) {
    await reportCompletion(false, undefined, "Invalid configuration");
    process.exit(1);
  }

  // Parse GitHub URL
  const gitInfo = parseGitHubUrl(GITHUB_URL);
  if (!gitInfo) {
    const error = `Invalid GitHub URL format: ${GITHUB_URL}`;
    logError(error);
    await reportCompletion(false, undefined, error);
    process.exit(1);
  }

  logInfo(
    `Parsed: owner=${gitInfo.owner}, repo=${gitInfo.repo}, branch=${gitInfo.branch}, path=${gitInfo.path || "(root)"}`,
  );

  // Clean up any previous work directory
  if (fs.existsSync(WORK_DIR)) {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }

  // Download GitHub directory
  logInfo("Downloading from GitHub...");
  if (!downloadGitHubDirectory(gitInfo, WORK_DIR)) {
    const error = "Failed to download from GitHub";
    await reportCompletion(false, undefined, error);
    process.exit(1);
  }

  // Find vm0.yaml
  logInfo("Looking for vm0.yaml...");
  const yamlPath = findVm0Yaml(WORK_DIR, gitInfo.path);
  if (!yamlPath) {
    const error = "vm0.yaml not found in repository";
    logError(error);
    await reportCompletion(false, undefined, error);
    process.exit(1);
  }

  logInfo(`Found: ${yamlPath}`);

  // Read and parse vm0.yaml
  const content = readVm0Yaml(yamlPath);
  if (!content) {
    const error = "Failed to parse vm0.yaml";
    await reportCompletion(false, undefined, error);
    process.exit(1);
  }

  // Create compose via API
  logInfo("Creating agent compose...");
  const result = await createCompose(content);
  if (!result) {
    const error = "Failed to create agent compose";
    await reportCompletion(false, undefined, error);
    process.exit(1);
  }

  logInfo(`Compose created: ${result.composeName} (${result.versionId})`);

  // Report success
  await reportCompletion(true, result);
  logInfo("Done!");
}

// Run main
main().catch(async (error) => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  logError(`Fatal error: ${errorMsg}`);
  await reportCompletion(false, undefined, errorMsg);
  process.exit(1);
});
