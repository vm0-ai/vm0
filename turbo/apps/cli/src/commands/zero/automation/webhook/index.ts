import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import type { WebhookAutomationResponse } from "../../../../lib/api";
import {
  createWebhookAutomation,
  listWebhookAutomations,
  deleteWebhookAutomation,
  resolveCompose,
} from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

/**
 * `zero automation webhook` — the events-first generic-webhook trigger surface.
 * These automations live on the new `automations` / `automation_triggers` tables
 * and are independent of the schedule-backed `zero automation setup` flow and
 * `zero schedule`. Creation mints an unguessable inbound URL plus an HMAC signing
 * secret; an external signed POST then fires the automation as an agent run.
 */

// Header the inbound route verifies the HMAC-SHA256 body signature against
// (mirrors the GitHub webhook: `sha256=<hex>`). Kept in sync with
// SIGNATURE_HEADER in apps/api webhooks-automation.service.ts.
const SIGNATURE_HEADER = "x-vm0-signature-256";

function resolveInstruction(
  prompt: string | undefined,
  promptFile: string | undefined,
): string {
  if (prompt && promptFile) {
    throw new Error("Cannot use --prompt and --prompt-file together");
  }
  if (promptFile) {
    return readFileSync(promptFile, "utf-8");
  }
  if (prompt) {
    return prompt;
  }
  throw new Error("--prompt or --prompt-file is required");
}

/**
 * A copy-pasteable, signed `curl` that the caller can run to fire the webhook.
 * The body is signed exactly the way the inbound route verifies it: an
 * HMAC-SHA256 of the raw request body keyed by the secret, sent as
 * `<header>: sha256=<hex>`.
 */
function signedCurlExample(webhookUrl: string, secret: string): string {
  return [
    `SECRET='${secret}'`,
    `BODY='{"hello":"world"}'`,
    `SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"`,
    `curl -X POST '${webhookUrl}' \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "${SIGNATURE_HEADER}: $SIG" \\`,
    `  -d "$BODY"`,
  ].join("\n");
}

function printCreated(
  automation: WebhookAutomationResponse,
  secret: string,
): void {
  console.log(chalk.green(`✓ Webhook automation "${automation.name}" created`));
  console.log(chalk.dim(`  ID:      ${automation.id}`));
  console.log(chalk.dim(`  Agent:   ${automation.agentId}`));
  console.log(chalk.dim(`  Thread:  ${automation.chatThreadId}`));
  console.log();
  console.log(chalk.bold("  Inbound URL:"));
  console.log(`    ${automation.webhookUrl}`);
  console.log();
  console.log(chalk.bold("  Signing secret (shown once — store it now):"));
  console.log(`    ${secret}`);
  console.log();
  console.log(chalk.bold("  Example (signed curl):"));
  for (const line of signedCurlExample(automation.webhookUrl, secret).split(
    "\n",
  )) {
    console.log(`    ${line}`);
  }
}

const createCommand = new Command()
  .name("create")
  .description("Create a webhook-triggered automation for a zero agent")
  .requiredOption("--agent-id <id>", "Agent ID or name to run on webhook")
  .requiredOption("-n, --name <name>", "Automation name")
  .option("-p, --prompt <text>", "Instruction the agent runs on each webhook")
  .option(
    "--prompt-file <path>",
    "Read the instruction from a file (cannot be used with --prompt)",
  )
  .option("--description <text>", "Optional description")
  .option("--json", "Print raw JSON (includes the secret)")
  .addHelpText(
    "after",
    `
Examples:
  Create:  zero automation webhook create --agent-id <agent-id> -n alerts -p "Summarize the incoming alert"
  From file:  zero automation webhook create --agent-id <agent-id> -n alerts --prompt-file ./instruction.md

Notes:
  - The signing secret is shown ONCE on creation and never again — store it securely.
  - Sign the raw request body with HMAC-SHA256 and send it as the ${SIGNATURE_HEADER} header.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        agentId: string;
        name: string;
        prompt?: string;
        promptFile?: string;
        description?: string;
        json?: boolean;
      }) => {
        const instruction = resolveInstruction(
          options.prompt,
          options.promptFile,
        );

        const compose = await resolveCompose(options.agentId);
        if (!compose) {
          throw new Error(`Agent not found: ${options.agentId}`);
        }

        const result = await createWebhookAutomation({
          name: options.name,
          instruction,
          agentId: compose.id,
          description: options.description,
        });

        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }

        printCreated(result.automation, result.secret);
      },
    ),
  );

function printList(automations: readonly WebhookAutomationResponse[]): void {
  if (automations.length === 0) {
    console.log(chalk.dim("No webhook automations found"));
    console.log(
      chalk.dim(
        "  Create one with: zero automation webhook create --agent-id <agent-id> -n <name> -p <prompt>",
      ),
    );
    return;
  }

  const idWidth = Math.max(
    2,
    ...automations.map((a) => {
      return a.id.length;
    }),
  );
  const nameWidth = Math.max(
    4,
    ...automations.map((a) => {
      return a.name.length;
    }),
  );
  const agentWidth = Math.max(
    5,
    ...automations.map((a) => {
      return a.agentId.length;
    }),
  );

  console.log(
    chalk.dim(
      [
        "ID".padEnd(idWidth),
        "NAME".padEnd(nameWidth),
        "AGENT".padEnd(agentWidth),
        "STATUS".padEnd(8),
        "WEBHOOK URL",
      ].join("  "),
    ),
  );

  for (const automation of automations) {
    const status = automation.enabled
      ? chalk.green("enabled")
      : chalk.yellow("disabled");
    console.log(
      [
        automation.id.padEnd(idWidth),
        automation.name.padEnd(nameWidth),
        automation.agentId.padEnd(agentWidth),
        status.padEnd(8 + (automation.enabled ? 0 : 2)),
        automation.webhookUrl,
      ].join("  "),
    );
  }
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List webhook automations")
  .option("--json", "Print raw JSON")
  .addHelpText(
    "after",
    `
Examples:
  zero automation webhook list`,
  )
  .action(
    withErrorHandler(async (options: { json?: boolean }) => {
      const result = await listWebhookAutomations();

      if (options.json) {
        console.log(JSON.stringify(result.automations));
        return;
      }

      printList(result.automations);
    }),
  );

const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a webhook automation by ID")
  .argument("<automation-id>", "Webhook automation ID")
  .option("--json", "Print raw JSON")
  .addHelpText(
    "after",
    `
Examples:
  zero automation webhook delete <automation-id>`,
  )
  .action(
    withErrorHandler(
      async (automationId: string, options: { json?: boolean }) => {
        await deleteWebhookAutomation(automationId);

        if (options.json) {
          console.log(JSON.stringify({ id: automationId, deleted: true }));
          return;
        }

        console.log(
          chalk.green(`✓ Webhook automation ${automationId} deleted`),
        );
      },
    ),
  );

export const webhookCommand = new Command()
  .name("webhook")
  .description("Manage webhook-triggered automations")
  .addCommand(createCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create:  zero automation webhook create --agent-id <agent-id> -n alerts -p "Summarize the alert"
  List:    zero automation webhook list
  Delete:  zero automation webhook delete <automation-id>

Notes:
  - Webhook automations are separate from the time/schedule automations created by "zero automation setup".
  - On create, the inbound URL and a one-time signing secret are printed; store the secret securely.`,
  );
