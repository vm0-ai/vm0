import { Sandbox } from "@vercel/sandbox";

import {
  CLI_AUTH_TOOLCHAIN_MANIFEST_PATH,
  CLI_AUTH_TOOLCHAIN_RUNTIME,
  CLI_AUTH_TOOLCHAIN_STRIPE_BIN,
  CLI_AUTH_TOOLCHAIN_STRIPE_VERSION,
  cliAuthStripeInstallScript,
  cliAuthStripeManifestScript,
  cliAuthStripeVersionScript,
} from "../src/signals/services/cli-auth-toolchain.service";

const DEFAULT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;
const EXPIRATION_ARG = "--expiration-ms";

interface CommandSummary {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ToolchainManifest {
  readonly version: 1;
  readonly runtime: typeof CLI_AUTH_TOOLCHAIN_RUNTIME;
  readonly builtAt: string;
  readonly gitCommitSha: string | null;
  readonly tools: readonly {
    readonly name: "stripe";
    readonly version: typeof CLI_AUTH_TOOLCHAIN_STRIPE_VERSION;
    readonly path: typeof CLI_AUTH_TOOLCHAIN_STRIPE_BIN;
  }[];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function expirationMsFromArgs(args: readonly string[]): number {
  const index = args.indexOf(EXPIRATION_ARG);
  if (index === -1) {
    return DEFAULT_EXPIRATION_MS;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${EXPIRATION_ARG} requires a value`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${EXPIRATION_ARG} must be a non-negative integer`);
  }
  return parsed;
}

async function runCheckedCommand(args: {
  readonly sandbox: Sandbox;
  readonly label: string;
  readonly script: string;
}): Promise<CommandSummary> {
  const command = await args.sandbox.runCommand({
    cmd: "sh",
    args: ["-lc", args.script],
  });
  const [stdout, stderr] = await Promise.all([
    command.stdout(),
    command.stderr(),
  ]);
  if (command.exitCode !== 0) {
    throw new Error(
      `${args.label} failed with exit code ${String(
        command.exitCode,
      )}: ${stderr || stdout}`,
    );
  }
  return {
    exitCode: command.exitCode,
    stdout,
    stderr,
  };
}

function manifest(): ToolchainManifest {
  return {
    version: 1,
    runtime: CLI_AUTH_TOOLCHAIN_RUNTIME,
    builtAt: new Date().toISOString(),
    gitCommitSha: process.env.GIT_COMMIT_SHA || process.env.GITHUB_SHA || null,
    tools: [
      {
        name: "stripe",
        version: CLI_AUTH_TOOLCHAIN_STRIPE_VERSION,
        path: CLI_AUTH_TOOLCHAIN_STRIPE_BIN,
      },
    ],
  };
}

async function main(): Promise<void> {
  const expiration = expirationMsFromArgs(process.argv.slice(2));
  const credentials = {
    teamId: requiredEnv("VERCEL_TEAM_ID"),
    projectId: requiredEnv("VERCEL_PROJECT_ID"),
    token: requiredEnv("VERCEL_TOKEN"),
  };

  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: CLI_AUTH_TOOLCHAIN_RUNTIME,
    timeout: 15 * 60 * 1000,
  });
  let snapshotted = false;

  try {
    const install = await runCheckedCommand({
      sandbox,
      label: "install Stripe CLI auth toolchain",
      script: cliAuthStripeInstallScript(),
    });
    const verify = await runCheckedCommand({
      sandbox,
      label: "verify Stripe CLI auth toolchain",
      script: cliAuthStripeVersionScript(),
    });
    const toolchainManifest = manifest();
    await runCheckedCommand({
      sandbox,
      label: "write CLI auth toolchain manifest",
      script: cliAuthStripeManifestScript(
        JSON.stringify(toolchainManifest, null, 2),
      ),
    });
    const snapshot = await sandbox.snapshot({ expiration });
    snapshotted = true;

    process.stdout.write(
      `${JSON.stringify({
        snapshotId: snapshot.snapshotId,
        expiresAt: snapshot.expiresAt?.toISOString() ?? null,
        manifestPath: CLI_AUTH_TOOLCHAIN_MANIFEST_PATH,
        manifest: toolchainManifest,
        verification: {
          install,
          stripeVersion: verify,
        },
      })}\n`,
    );
  } finally {
    if (!snapshotted) {
      await sandbox.stop().catch((error: unknown) => {
        process.stderr.write(
          `Failed to stop CLI auth toolchain builder sandbox after failure: ${String(
            error,
          )}\n`,
        );
      });
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
