import chalk from "chalk";

export function printTranscript(transcript: unknown): void {
  if (Array.isArray(transcript)) {
    for (const entry of transcript) {
      if (typeof entry === "string") {
        console.log(`  ${entry}`);
      } else if (typeof entry === "object" && entry !== null) {
        const e = entry as Record<string, unknown>;
        const role = e.role ?? e.speaker ?? "Unknown";
        const text = e.text ?? e.content ?? e.body ?? "";
        console.log(`  ${chalk.dim(`[${role}]`)} ${text}`);
      }
    }
  } else if (typeof transcript === "string") {
    console.log(`  ${transcript}`);
  } else {
    console.log(`  ${JSON.stringify(transcript, null, 2)}`);
  }
}

export function printCallInfo(
  call: Record<string, unknown>,
  callId: string,
): void {
  console.log(
    `  ${"Call ID:".padEnd(16)}${chalk.cyan(String(call.id ?? callId))}`,
  );
  console.log(
    `  ${"From:".padEnd(16)}${String(call.fromNumber ?? call.from_number ?? "")}`,
  );
  console.log(
    `  ${"To:".padEnd(16)}${String(call.toNumber ?? call.to_number ?? "")}`,
  );
  console.log(`  ${"Status:".padEnd(16)}${String(call.status ?? "")}`);
  console.log(
    `  ${"Duration:".padEnd(16)}${String(call.durationSeconds ?? call.duration_seconds ?? "N/A")}s`,
  );
  console.log(
    `  ${"Started:".padEnd(16)}${String(call.startedAt ?? call.started_at ?? "")}`,
  );
}
