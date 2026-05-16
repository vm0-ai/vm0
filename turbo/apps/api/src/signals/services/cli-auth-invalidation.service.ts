import type { ConnectorType } from "@vm0/connectors/connectors";

import type { Db } from "../external/db";
import type { SandboxHandle } from "../external/sandbox";
import {
  cancelActiveCliAuthStripeSessionsForCredentialsChange,
  cleanupInvalidatedCliAuthStripeSandboxes,
  invalidateActiveCliAuthStripeSessions,
} from "./cli-auth-stripe.service";

type CliAuthInvalidationArgs = {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
};

type CliAuthInvalidator = (args: CliAuthInvalidationArgs) => Promise<void>;

const cliAuthInvalidatorsBySecretName = Object.freeze<
  Readonly<Partial<Record<string, readonly CliAuthInvalidator[]>>>
>({
  STRIPE_TOKEN: Object.freeze([invalidateActiveCliAuthStripeSessions]),
});

const cliAuthInvalidatorsByConnectorType = Object.freeze<
  Readonly<Partial<Record<ConnectorType, readonly CliAuthInvalidator[]>>>
>({
  stripe: Object.freeze([invalidateActiveCliAuthStripeSessions]),
});

type PreparedCliAuthSessionInvalidation = {
  readonly type: "stripe";
  readonly sandboxes: readonly SandboxHandle[];
};

async function runCliAuthInvalidators(
  invalidators: readonly CliAuthInvalidator[],
  args: CliAuthInvalidationArgs,
) {
  const seen = new Set<CliAuthInvalidator>();
  for (const invalidate of invalidators) {
    if (seen.has(invalidate)) {
      continue;
    }
    seen.add(invalidate);
    await invalidate(args);
  }
}

export function hasCliAuthInvalidatorsForSecretName(
  secretName: string,
): boolean {
  return Boolean(cliAuthInvalidatorsBySecretName[secretName]);
}

export async function invalidateActiveCliAuthSessionsForSecretName(
  args: CliAuthInvalidationArgs & { readonly secretName: string },
) {
  await runCliAuthInvalidators(
    cliAuthInvalidatorsBySecretName[args.secretName] ?? [],
    args,
  );
}

export async function invalidateActiveCliAuthSessionsForConnectorType(
  args: CliAuthInvalidationArgs & { readonly connectorType: ConnectorType },
) {
  await runCliAuthInvalidators(
    cliAuthInvalidatorsByConnectorType[args.connectorType] ?? [],
    args,
  );
}

export async function prepareActiveCliAuthSessionInvalidationsForConnectorType(
  args: CliAuthInvalidationArgs & { readonly connectorType: ConnectorType },
): Promise<readonly PreparedCliAuthSessionInvalidation[]> {
  if (args.connectorType !== "stripe") {
    return [];
  }

  const sandboxes = await cancelActiveCliAuthStripeSessionsForCredentialsChange(
    {
      db: args.writeDb,
      orgId: args.orgId,
      userId: args.userId,
    },
  );
  args.signal.throwIfAborted();
  if (sandboxes.length === 0) {
    return [];
  }
  return [{ type: "stripe", sandboxes }];
}

export async function cleanupPreparedCliAuthSessionInvalidations(
  invalidations: readonly PreparedCliAuthSessionInvalidation[],
) {
  for (const invalidation of invalidations) {
    switch (invalidation.type) {
      case "stripe": {
        await cleanupInvalidatedCliAuthStripeSandboxes(invalidation.sandboxes);
        break;
      }
    }
  }
}
