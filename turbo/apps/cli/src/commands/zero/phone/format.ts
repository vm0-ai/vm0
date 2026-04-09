import chalk from "chalk";
import type { PhoneCall, TranscriptEntry } from "../../../lib/api";

export function printTranscript(transcript: TranscriptEntry[] | null): void {
  if (!transcript || transcript.length === 0) {
    console.log("  (no transcript)");
    return;
  }
  for (const entry of transcript) {
    console.log(`  ${chalk.dim(`[${entry.role}]`)} ${entry.text}`);
  }
}

export function printCallInfo(call: PhoneCall, callId: string): void {
  console.log(`  ${"Call ID:".padEnd(16)}${chalk.cyan(call.id ?? callId)}`);
  console.log(`  ${"From:".padEnd(16)}${call.fromNumber}`);
  console.log(`  ${"To:".padEnd(16)}${call.toNumber}`);
  console.log(`  ${"Status:".padEnd(16)}${call.status}`);
  console.log(
    `  ${"Duration:".padEnd(16)}${call.durationSeconds != null ? `${call.durationSeconds}s` : "N/A"}`,
  );
  console.log(`  ${"Started:".padEnd(16)}${call.startedAt ?? ""}`);
}
