import { Command } from "commander";

export const setupCommand = new Command("setup")
  .description("Configure runner (generates keys, authenticates)")
  .action(() => {
    console.log("Setup command not yet implemented");
    console.log("This will:");
    console.log("  - Generate RSA key pair");
    console.log("  - Authenticate with VM0 server");
    process.exit(0);
  });
