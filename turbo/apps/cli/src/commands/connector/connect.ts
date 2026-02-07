import { Command } from "commander";
import chalk from "chalk";
import { initClient } from "@ts-rest/core";
import {
  connectorSessionsContract,
  connectorSessionByIdContract,
  connectorTypeSchema,
  type ApiErrorResponse,
} from "@vm0/core";
import { getApiUrl, getToken } from "../../lib/api/config";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Run: vm0 auth login");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  // Add Vercel bypass secret if available (for CI/preview deployments)
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  return headers;
}

export const connectCommand = new Command()
  .name("connect")
  .description("Connect a third-party service (e.g., GitHub)")
  .argument("<type>", "Connector type (e.g., github)")
  .action(async (type: string) => {
    // Validate connector type with runtime validation
    const parseResult = connectorTypeSchema.safeParse(type);
    if (!parseResult.success) {
      console.error(chalk.red(`Unknown connector type: ${type}`));
      console.error("Available connectors: github");
      process.exit(1);
    }

    const connectorType = parseResult.data;
    const apiUrl = await getApiUrl();
    const headers = await getHeaders();

    console.log(`Connecting ${chalk.cyan(type)}...`);

    // Create session
    const sessionsClient = initClient(connectorSessionsContract, {
      baseUrl: apiUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const createResult = await sessionsClient.create({
      params: { type: connectorType },
      body: {},
    });

    if (createResult.status !== 200) {
      const errorBody = createResult.body as ApiErrorResponse;
      console.error(
        chalk.red(`Failed to create session: ${errorBody.error?.message}`),
      );
      process.exit(1);
    }

    const session = createResult.body;
    const verificationUrl = `${apiUrl}${session.verificationUrl}`;

    console.log(chalk.green("\nSession created"));
    console.log(chalk.cyan(`\nTo connect, visit: ${verificationUrl}`));
    console.log(
      `\nThe session expires in ${Math.floor(session.expiresIn / 60)} minutes.`,
    );

    console.log("\nWaiting for authorization...");

    // Poll for completion
    const sessionClient = initClient(connectorSessionByIdContract, {
      baseUrl: apiUrl,
      baseHeaders: headers,
      jsonQuery: true,
    });

    const startTime = Date.now();
    const maxWaitTime = session.expiresIn * 1000;
    const pollInterval = (session.interval || 5) * 1000;

    let isFirstPoll = true;

    while (Date.now() - startTime < maxWaitTime) {
      // Skip delay on first poll
      if (!isFirstPoll) {
        await delay(pollInterval);
      }
      isFirstPoll = false;

      const statusResult = await sessionClient.get({
        params: { type: connectorType, sessionId: session.id },
      });

      if (statusResult.status !== 200) {
        const errorBody = statusResult.body as ApiErrorResponse;
        console.error(
          chalk.red(`\nFailed to check status: ${errorBody.error?.message}`),
        );
        process.exit(1);
      }

      const status = statusResult.body;

      switch (status.status) {
        case "complete":
          console.log(chalk.green(`\n\n${type} connected successfully!`));
          return;

        case "expired":
          console.log(chalk.red("\nSession expired. Please try again."));
          process.exit(1);
          break;

        case "error":
          console.log(
            chalk.red(
              `\nConnection failed: ${status.errorMessage || "Unknown error"}`,
            ),
          );
          process.exit(1);
          break;

        case "pending":
          // Still waiting
          process.stdout.write(chalk.dim("."));
          break;
      }
    }

    // Timeout
    console.log(chalk.red("\nSession timed out. Please try again."));
    process.exit(1);
  });
