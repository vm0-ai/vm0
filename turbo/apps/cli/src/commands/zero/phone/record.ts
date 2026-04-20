import { Command } from "commander";
import chalk from "chalk";
import { listPhoneCalls, getPhoneCallDetail } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printTranscript, printCallInfo } from "./format";

async function showCallDetail(callId: string) {
  const result = await getPhoneCallDetail(callId);

  console.log(chalk.bold("Call Detail"));
  console.log();
  printCallInfo(result.call, callId);
  console.log();
  console.log(chalk.bold("Transcript"));
  console.log();
  printTranscript(result.transcript);
}

async function showCallList(limit: number) {
  const result = await listPhoneCalls({ limit });

  if (result.data.length === 0) {
    console.log(chalk.dim("No phone calls found"));
    return;
  }

  console.log(chalk.bold("Recent Calls"));
  console.log();

  for (const call of result.data) {
    const id = call.id;
    const from = call.fromNumber;
    const to = call.toNumber;
    const status = call.status;
    const duration = call.durationSeconds;
    const snippet = call.lastTranscriptSnippet ?? "";

    console.log(`  ${chalk.cyan(id)}`);
    console.log(
      `    ${from} → ${to}  ${chalk.dim(status)}${duration != null ? `  ${duration}s` : ""}`,
    );
    if (snippet) {
      console.log(`    ${chalk.dim(snippet.slice(0, 80))}`);
    }
    console.log();
  }

  console.log(
    chalk.dim(`Showing ${result.data.length} of ${result.total} call(s)`),
  );
}

export const recordCommand = new Command()
  .name("record")
  .description("View phone call history and transcripts")
  .argument("[call-id]", "Call ID to view details (omit to list recent calls)")
  .option("-n, --limit <number>", "Number of calls to show", "10")
  .action(
    withErrorHandler(
      async (callId: string | undefined, options: { limit: string }) => {
        if (callId) {
          await showCallDetail(callId);
        } else {
          const limit = parseInt(options.limit, 10) || 10;
          await showCallList(limit);
        }
      },
    ),
  );
