import { Command } from "commander";
import chalk from "chalk";
import type { CreateTriggerRequest } from "@vm0/api-contracts/contracts/automations-v2";
import { addAutomationTriggerV2 } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import { parseDurationSeconds } from "../duration";
import { printTriggerDetails, printWebhookSecret } from "../trigger-display";

interface AddOptions {
  expr?: string;
  at?: string;
  every?: string;
  timezone?: string;
}

const TRIGGER_KINDS = ["cron", "once", "loop", "webhook"] as const;

/**
 * Build the trigger creation request from the kind keyword plus its own flag:
 * cron → --expr, once → --at, loop → --every, webhook → nothing.
 */
function buildTrigger(kind: string, options: AddOptions): CreateTriggerRequest {
  switch (kind) {
    case "cron":
      if (!options.expr) {
        throw new Error(
          'cron triggers require --expr (e.g. --expr "0 9 * * *")',
        );
      }
      return {
        kind: "cron",
        cronExpression: options.expr,
        timezone: options.timezone,
      };
    case "once":
      if (!options.at) {
        throw new Error(
          'once triggers require --at (e.g. --at "2026-06-10T09:00")',
        );
      }
      return { kind: "once", atTime: options.at, timezone: options.timezone };
    case "loop":
      if (!options.every) {
        throw new Error("loop triggers require --every (e.g. --every 15m)");
      }
      return {
        kind: "loop",
        intervalSeconds: parseDurationSeconds(options.every),
      };
    case "webhook":
      return { kind: "webhook" };
    default:
      throw new Error(
        `Unknown trigger kind: "${kind}". Use one of: ${TRIGGER_KINDS.join(", ")}`,
      );
  }
}

export const addCommand = new Command()
  .name("add")
  .description("Add a trigger (cron | once | loop | webhook) to an automation")
  .argument("<automation>", "Automation ID or name")
  .argument("<kind>", `Trigger kind: ${TRIGGER_KINDS.join(" | ")}`)
  .option(
    "--expr <expression>",
    'Cron expression for kind "cron" (e.g. "0 9 * * *")',
  )
  .option(
    "--at <iso-time>",
    'Fire time for kind "once" (e.g. "2026-06-10T09:00")',
  )
  .option("--every <duration>", 'Interval for kind "loop" (e.g. 15m, 1h, 90s)')
  .option("-z, --timezone <tz>", "IANA timezone for cron/once")
  .addHelpText(
    "after",
    `
Trigger kinds:
  cron     Recurring schedule:      zero automation trigger add alerts cron --expr "0 9 * * *" [--timezone Asia/Shanghai]
  once     One-time fire:           zero automation trigger add alerts once --at "2026-06-10T09:00" [--timezone UTC]
  loop     Fixed interval:          zero automation trigger add alerts loop --every 15m
  webhook  Inbound signed webhook:  zero automation trigger add alerts webhook

Notes:
  - A webhook trigger prints its inbound URL plus a signing secret shown ONCE — store it securely`,
  )
  .action(
    withErrorHandler(async (ref: string, kind: string, options: AddOptions) => {
      if (options.timezone && kind !== "cron" && kind !== "once") {
        throw new Error("--timezone only applies to cron and once triggers");
      }

      const body = buildTrigger(kind, options);

      const { trigger, webhookSecret } = await addAutomationTriggerV2(
        ref,
        body,
      );

      console.log(chalk.green(`✓ Trigger added to automation "${ref}"`));
      printTriggerDetails(trigger);

      if (webhookSecret && trigger.kind === "webhook") {
        printWebhookSecret(trigger.webhookUrl, webhookSecret);
      }
    }),
  );
