import { Command } from "commander";
import { authenticate, testConnection } from "../lib/auth.js";

export const setupCommand = new Command("setup")
  .description("Configure runner authentication with VM0 server")
  .option("--api-url <url>", "VM0 API URL (defaults to https://www.vm0.ai)")
  .option("--test", "Test existing connection without re-authenticating")
  .action(
    async (options: { apiUrl?: string; test?: boolean }): Promise<void> => {
      if (options.test) {
        const success = await testConnection();
        process.exit(success ? 0 : 1);
      }

      await authenticate(options.apiUrl);
      console.log("\nRunner setup complete!");
      console.log("You can now start the runner with: vm0-runner start");
    },
  );
