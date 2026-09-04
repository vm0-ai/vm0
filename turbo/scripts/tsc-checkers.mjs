#!/usr/bin/env node
// Prints the TypeScript 7 `--checkers` count for this machine.
//
// TSC_CHECKERS overrides the heuristic. Otherwise allow one checker per 4 GiB
// of RAM (the API core program peaks near 3 GiB per checker), never more than
// the CPU count or TypeScript's default of 4, and never fewer than 1. A 2 vCPU /
// 4 GiB sandbox therefore gets 1 and a 4 vCPU / 16 GiB CI runner gets 4.
import os from "node:os";

const override = process.env.TSC_CHECKERS;
if (override !== undefined && /^[1-9]\d*$/.test(override)) {
  console.log(override);
} else {
  const byMemory = Math.floor(os.totalmem() / (4 * 1024 ** 3));
  const byCpu = os.availableParallelism();
  console.log(String(Math.max(1, Math.min(4, byMemory, byCpu))));
}
