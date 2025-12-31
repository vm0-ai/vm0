import { Command } from "commander";

export const statusCommand = new Command("status")
  .description("Show runner status")
  .action(() => {
    console.log("Status command not yet implemented");
    process.exit(0);
  });
