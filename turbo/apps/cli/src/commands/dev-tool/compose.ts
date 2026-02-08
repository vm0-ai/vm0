import { Command } from "commander";
import chalk from "chalk";
import { initClient } from "@ts-rest/core";
import { composeJobsMainContract, composeJobsByIdContract } from "@vm0/core";
import { getClientConfig } from "../../lib/api/core/client-factory";

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format timestamp for log output
 */
function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

/**
 * Create a compose job via API
 */
async function createComposeJob(
  githubUrl: string,
  overwrite: boolean,
): Promise<{ jobId: string; status: string }> {
  const config = await getClientConfig();
  const client = initClient(composeJobsMainContract, config);

  const result = await client.create({
    body: { githubUrl, overwrite },
  });

  if (result.status === 200 || result.status === 201) {
    return {
      jobId: result.body.jobId,
      status: result.body.status,
    };
  }

  if (result.status === 400 || result.status === 401) {
    throw new Error(result.body.error.message);
  }

  throw new Error(`Unexpected response: ${result.status}`);
}

/**
 * Get compose job status via API
 */
async function getComposeJobStatus(jobId: string): Promise<{
  status: string;
  result?: {
    composeId: string;
    composeName: string;
    versionId: string;
    warnings: string[];
  };
  error?: string;
}> {
  const config = await getClientConfig();
  const client = initClient(composeJobsByIdContract, config);

  const result = await client.getById({
    params: { jobId },
  });

  if (result.status === 200) {
    return {
      status: result.body.status,
      result: result.body.result,
      error: result.body.error,
    };
  }

  if (result.status === 404) {
    throw new Error(`Job not found: ${jobId}`);
  }

  if (result.status === 401) {
    throw new Error(result.body.error.message);
  }

  throw new Error(`Unexpected response: ${result.status}`);
}

/**
 * Poll job until completion or timeout
 */
async function pollUntilComplete(
  jobId: string,
  intervalMs: number,
  timeoutMs: number,
  jsonMode: boolean,
): Promise<{
  status: string;
  result?: {
    composeId: string;
    composeName: string;
    versionId: string;
    warnings: string[];
  };
  error?: string;
}> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const job = await getComposeJobStatus(jobId);

    if (!jsonMode) {
      console.log(
        chalk.dim(`[${timestamp()}] Polling... status=${job.status}`),
      );
    }

    if (job.status === "completed" || job.status === "failed") {
      return job;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timeout after ${timeoutMs / 1000} seconds`);
}

export const composeCommand = new Command()
  .name("compose")
  .description("Test server-side GitHub compose API")
  .argument("<github-url>", "GitHub URL to compose from")
  .option("--overwrite", "Overwrite existing compose", false)
  .option(
    "--interval <seconds>",
    "Polling interval in seconds",
    (v) => parseInt(v, 10),
    5,
  )
  .option(
    "--timeout <seconds>",
    "Maximum wait time in seconds",
    (v) => parseInt(v, 10),
    300,
  )
  .option("--json", "Output result as JSON")
  .action(
    async (
      githubUrl: string,
      options: {
        overwrite: boolean;
        interval: number;
        timeout: number;
        json?: boolean;
      },
    ) => {
      const intervalMs = options.interval * 1000;
      const timeoutMs = options.timeout * 1000;

      try {
        // Create job
        if (!options.json) {
          console.log("Creating compose job...");
        }

        const { jobId, status: initialStatus } = await createComposeJob(
          githubUrl,
          options.overwrite,
        );

        if (!options.json) {
          console.log(`Job ID: ${chalk.cyan(jobId)}`);
          console.log();
        }

        // If already completed (shouldn't happen, but handle it)
        if (initialStatus === "completed" || initialStatus === "failed") {
          const finalJob = await getComposeJobStatus(jobId);
          if (options.json) {
            console.log(JSON.stringify(finalJob, null, 2));
          } else {
            displayResult(finalJob);
          }
          process.exit(finalJob.status === "completed" ? 0 : 1);
        }

        // Poll until complete
        const finalJob = await pollUntilComplete(
          jobId,
          intervalMs,
          timeoutMs,
          !!options.json,
        );

        // Output result
        if (options.json) {
          console.log(JSON.stringify(finalJob, null, 2));
        } else {
          console.log();
          displayResult(finalJob);
        }

        process.exit(finalJob.status === "completed" ? 0 : 1);
      } catch (error) {
        if (options.json) {
          console.log(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        } else {
          console.error(
            chalk.red(
              `✗ ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
        process.exit(1);
      }
    },
  );

/**
 * Display human-readable result
 */
function displayResult(job: {
  status: string;
  result?: {
    composeId: string;
    composeName: string;
    versionId: string;
    warnings: string[];
  };
  error?: string;
}): void {
  if (job.status === "completed" && job.result) {
    console.log(chalk.green("✓ Compose completed!"));
    console.log(`  Compose ID: ${chalk.cyan(job.result.composeId)}`);
    console.log(`  Name: ${chalk.cyan(job.result.composeName)}`);
    console.log(`  Version: ${chalk.cyan(job.result.versionId.slice(0, 8))}`);
    if (job.result.warnings.length > 0) {
      console.log();
      console.log(chalk.yellow("  Warnings:"));
      for (const warning of job.result.warnings) {
        console.log(chalk.yellow(`    - ${warning}`));
      }
    }
  } else if (job.status === "failed") {
    console.error(chalk.red("✗ Compose failed"));
    if (job.error) {
      console.error(`  Error: ${chalk.red(job.error)}`);
    }
  } else {
    console.log(`Status: ${job.status}`);
  }
}
