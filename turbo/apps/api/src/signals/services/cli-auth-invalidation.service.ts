import type { ConnectorType } from "@vm0/connectors/connectors";

import type { Db } from "../external/db";
import { invalidateActiveCliAuthStripeSessions } from "./cli-auth-stripe.service";

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
