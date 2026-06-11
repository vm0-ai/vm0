import { Command } from "commander";
import chalk from "chalk";
import {
  disableAutomationTriggerV2,
  enableAutomationTriggerV2,
  listAutomationTriggersV2,
  removeAutomationTriggerV2,
  rotateAutomationTriggerSecretV2,
  showAutomationTriggerV2,
} from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import {
  printTriggerDetails,
  printTriggersTable,
  printWebhookSecret,
} from "../trigger-display";
import { addCommand } from "./add";

/**
 * `zero automation trigger` — manage the triggers of a unified automation.
 * Triggers are addressed by their UUID (see `trigger list <automation>`);
 * only `add` and `list` take the automation ref.
 */

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List an automation's triggers")
  .argument("<automation>", "Automation ID or name")
  .addHelpText(
    "after",
    `
Examples:
  zero automation trigger list alerts`,
  )
  .action(
    withErrorHandler(async (ref: string) => {
      const { triggers } = await listAutomationTriggersV2(ref);

      if (triggers.length === 0) {
        console.log(chalk.dim("No triggers"));
        console.log(
          chalk.dim(
            `  Add one with: zero automation trigger add ${ref} cron --expr "0 9 * * *"`,
          ),
        );
        return;
      }

      printTriggersTable(triggers);
    }),
  );

const showCommand = new Command()
  .name("show")
  .description("Show a trigger")
  .argument("<trigger>", "Trigger ID")
  .addHelpText(
    "after",
    `
Examples:
  zero automation trigger show 22222222-2222-4222-8222-222222222222`,
  )
  .action(
    withErrorHandler(async (id: string) => {
      const trigger = await showAutomationTriggerV2(id);

      printTriggerDetails(trigger);
    }),
  );

const rmCommand = new Command()
  .name("rm")
  .alias("remove")
  .description("Remove a trigger")
  .argument("<trigger>", "Trigger ID")
  .addHelpText(
    "after",
    `
Examples:
  zero automation trigger rm 22222222-2222-4222-8222-222222222222`,
  )
  .action(
    withErrorHandler(async (id: string) => {
      await removeAutomationTriggerV2(id);

      console.log(chalk.green(`✓ Trigger ${id} removed`));
    }),
  );

const enableCommand = new Command()
  .name("enable")
  .description("Enable a single trigger")
  .argument("<trigger>", "Trigger ID")
  .addHelpText(
    "after",
    `
Examples:
  zero automation trigger enable 22222222-2222-4222-8222-222222222222`,
  )
  .action(
    withErrorHandler(async (id: string) => {
      const trigger = await enableAutomationTriggerV2(id);

      console.log(chalk.green(`✓ Trigger ${trigger.id} enabled`));
    }),
  );

const disableCommand = new Command()
  .name("disable")
  .description("Disable a single trigger")
  .argument("<trigger>", "Trigger ID")
  .addHelpText(
    "after",
    `
Examples:
  zero automation trigger disable 22222222-2222-4222-8222-222222222222`,
  )
  .action(
    withErrorHandler(async (id: string) => {
      const trigger = await disableAutomationTriggerV2(id);

      console.log(chalk.green(`✓ Trigger ${trigger.id} disabled`));
    }),
  );

const rotateSecretCommand = new Command()
  .name("rotate-secret")
  .description("Rotate a webhook trigger's signing secret (shown once)")
  .argument("<trigger>", "Webhook trigger ID")
  .addHelpText(
    "after",
    `
Examples:
  zero automation trigger rotate-secret 22222222-2222-4222-8222-222222222222

Notes:
  - The previous secret stops working immediately; the new one is shown ONCE`,
  )
  .action(
    withErrorHandler(async (id: string) => {
      const { trigger, webhookSecret } =
        await rotateAutomationTriggerSecretV2(id);

      console.log(chalk.green(`✓ Trigger ${trigger.id} secret rotated`));

      if (webhookSecret && trigger.kind === "webhook") {
        printWebhookSecret(trigger.webhookUrl, webhookSecret);
      }
    }),
  );

export const triggerCommand = new Command()
  .name("trigger")
  .description("Manage an automation's triggers")
  .addCommand(addCommand)
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(rmCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(rotateSecretCommand)
  .addHelpText(
    "after",
    `
Examples:
  Add a trigger:      zero automation trigger add <automation> cron --expr "0 9 * * *"
  List triggers:      zero automation trigger list <automation>
  Inspect a trigger:  zero automation trigger show <trigger-id>
  Pause one trigger:  zero automation trigger disable <trigger-id>
  Rotate a secret:    zero automation trigger rotate-secret <trigger-id>`,
  );
