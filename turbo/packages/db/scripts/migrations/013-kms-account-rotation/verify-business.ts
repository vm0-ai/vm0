#!/usr/bin/env tsx

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { verifyBusinessCanary } from "./business-canary";
import { object, string } from "./kms";

try {
  const directory = string(process.argv[2]);
  const reportPath = string(process.argv[3]);
  const old = object(
    JSON.parse(await readFile(join(directory, "old.json"), "utf8")),
  );
  const secret = string(process.env.CLERK_SECRET_KEY);
  const publishable = string(process.env.CLERK_PUBLISHABLE_KEY);
  const database = new URL(string(process.env.DATABASE_URL));
  if (
    !secret.startsWith("sk_live_") ||
    !publishable.startsWith("pk_live_") ||
    Buffer.from(publishable.slice(8), "base64").toString() !==
      "clerk.okou.ai$" ||
    !database.hostname.endsWith(".neon.tech") ||
    database.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error("invalid_production_configuration");
  }
  const report = await verifyBusinessCanary(
    {
      databaseUrl: database.toString(),
      apiOrigin: "https://api.okou.ai",
      clerkBackendOrigin: "https://api.clerk.com",
      clerkFrontendOrigin: "https://clerk.okou.ai",
      appOrigin: "https://app.okou.ai",
      clerkSecret: secret,
      userId: string(process.argv[4]),
      orgId: string(process.argv[5]),
      agentId: string(process.argv[6]),
      targetKey:
        "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947",
      sourceKey:
        "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8",
      oldEnvelope: string(old.envelope),
      oldLegacy: string(old.legacy),
    },
    async (checkpoint) => {
      await writeFile(reportPath, JSON.stringify(checkpoint, null, 2) + "\n", {
        mode: 0o600,
      });
    },
  );
  if (report.result !== "passed") process.exitCode = 1;
} catch {
  // Neither provider responses nor assertion values are safe diagnostic output.
  process.stderr.write(
    "Business verification failed; inspect the sanitized checkpoint.\n",
  );
  process.exitCode = 1;
}
