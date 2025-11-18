import chalk from "chalk";
import { APIClient, getAPIConfig } from "../lib/api-client";
import { success, error as outputError, info } from "../lib/output";

export async function runCommand(
  agentConfigId: string,
  prompt: string,
  options: {
    dynamicVars?: string;
    json?: boolean;
    verbose?: boolean;
  },
): Promise<void> {
  try {
    // 1. Parse dynamic vars
    let dynamicVars: Record<string, string> | undefined;
    if (options.dynamicVars) {
      try {
        dynamicVars = JSON.parse(options.dynamicVars) as Record<string, string>;
      } catch {
        throw new Error(
          "Invalid JSON for --dynamicVars.\n\n" +
            "Example:\n" +
            '  --dynamicVars \'{"userKey":"user-123"}\'',
        );
      }
    }

    // 2. Get API config
    const apiConfig = getAPIConfig();

    // 3. Create runtime
    const client = new APIClient(apiConfig);

    if (!options.json) {
      info("Creating runtime...");
    }

    const result = await client.createRuntime(
      agentConfigId,
      prompt,
      dynamicVars,
    );

    // 4. Output result
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      success(`Runtime created: ${result.runtimeId}`);
      success(`Executing in sandbox ${result.sandboxId}...`);
      success(`Completed in ${(result.executionTimeMs / 1000).toFixed(1)}s`);

      console.log();
      console.log(chalk.bold("Output:"));
      console.log(result.output);

      if (result.error) {
        console.log();
        console.log(chalk.red("Error:"));
        console.log(result.error);
      }

      if (options.verbose) {
        console.log();
        console.log(chalk.gray("Runtime ID:"), result.runtimeId);
        console.log(chalk.gray("Sandbox ID:"), result.sandboxId);
        console.log(chalk.gray("Status:"), result.status);
        console.log(
          chalk.gray("Execution Time:"),
          `${result.executionTimeMs}ms`,
        );
      }
    }
  } catch (err) {
    outputError(err instanceof Error ? err.message : "Unknown error");

    // Provide hints for common errors
    if (err instanceof Error) {
      if (err.message.includes("401")) {
        console.error(chalk.gray("\nHint: Check your VM0_API_KEY"));
      } else if (err.message.includes("404")) {
        console.error(
          chalk.gray("\nHint: Agent config not found. Check the config ID."),
        );
      } else if (err.message.includes("ECONNREFUSED")) {
        console.error(
          chalk.gray(
            "\nHint: Cannot connect to VM0 API. Check VM0_API_URL or ensure the server is running.",
          ),
        );
      }
    }

    process.exit(1);
  }
}
