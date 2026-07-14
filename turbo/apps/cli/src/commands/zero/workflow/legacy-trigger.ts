import { Command } from "commander";

// Remove with the legacy API aliases after the #21408 migration window.
export const legacyTriggerCommand = new Command("trigger")
  .helpOption(false)
  .allowUnknownOption()
  .argument("[args...]")
  .action(() => {
    console.error("renamed: use zero workflow automation");
    process.exit(1);
  });
