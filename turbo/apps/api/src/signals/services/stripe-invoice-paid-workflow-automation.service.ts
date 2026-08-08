import type { StripeInvoicePaidEventConfig } from "@vm0/api-contracts/contracts/zero-workflows";

import type { ReadonlyDb } from "../external/db";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  type ConnectorCredentialConnection,
} from "./connector-credential-runtime.service";

const STRIPE_CONNECTOR_SLUG = "stripe";
const STRIPE_LIVEMODE_VALUE_REF = "$vars.STRIPE_LIVEMODE";
const STRIPE_LIVEMODE_VARIABLE_NAME = "STRIPE_LIVEMODE";

const CONNECT_STRIPE_OAUTH_MESSAGE =
  "Connect Stripe with OAuth in Live mode before adding a Stripe invoice-paid automation";
const RECONNECT_STRIPE_OAUTH_MESSAGE =
  "Reconnect Stripe with OAuth before using Stripe invoice-paid automations";
const STRIPE_OAUTH_REQUIRED_MESSAGE =
  "Stripe invoice-paid automations require OAuth; reconnect Stripe using OAuth";
const STRIPE_LIVE_MODE_REQUIRED_MESSAGE =
  "Stripe invoice-paid automations require Live mode; reconnect Stripe in Live mode";
const STRIPE_BINDING_MISMATCH_MESSAGE =
  "The Stripe connection no longer matches this automation; delete and recreate the automation to bind the current Live-mode Stripe account";

interface StripeInvoicePaidAutomationBinding {
  readonly connectorId: string;
  readonly stripeAccountId: string;
  readonly mode: "live";
}

type StripeInvoicePaidAutomationReadinessResult =
  | {
      readonly kind: "ok";
      readonly binding: StripeInvoicePaidAutomationBinding;
    }
  | { readonly kind: "bad_request"; readonly message: string };

type ReadyStripeConnectionResult =
  | {
      readonly kind: "ok";
      readonly connection: ConnectorCredentialConnection;
      readonly stripeAccountId: string;
    }
  | { readonly kind: "bad_request"; readonly message: string };

function badRequest(message: string): ReadyStripeConnectionResult {
  return { kind: "bad_request", message };
}

async function loadReadyStripeConnection(
  args: {
    readonly connectorId?: string;
    readonly db: ReadonlyDb;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<ReadyStripeConnectionResult> {
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  signal.throwIfAborted();
  const loaded = await loadConnectorCredentialConnection({
    db: args.db,
    snapshot,
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: STRIPE_CONNECTOR_SLUG,
    ...(args.connectorId === undefined
      ? {}
      : { connectorId: args.connectorId }),
  });
  signal.throwIfAborted();
  if (loaded.kind === "missing") {
    return badRequest(
      args.connectorId === undefined
        ? CONNECT_STRIPE_OAUTH_MESSAGE
        : STRIPE_BINDING_MISMATCH_MESSAGE,
    );
  }
  if (loaded.kind === "unavailable") {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }

  const { connection } = loaded;
  if (connection.runtimeMethod.authMethodId !== "oauth") {
    return badRequest(STRIPE_OAUTH_REQUIRED_MESSAGE);
  }
  if (connection.needsReconnect) {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }
  const stripeAccountId = connection.externalId;
  if (stripeAccountId === null || stripeAccountId.trim().length === 0) {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }
  if (
    !connection.runtimeMethod.method.storage.variables.includes(
      STRIPE_LIVEMODE_VARIABLE_NAME,
    )
  ) {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }

  const values = await loadConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [STRIPE_LIVEMODE_VALUE_REF],
  });
  signal.throwIfAborted();
  const livemode = values.get(STRIPE_LIVEMODE_VALUE_REF);
  if (livemode === "false") {
    return badRequest(STRIPE_LIVE_MODE_REQUIRED_MESSAGE);
  }
  if (livemode !== "true") {
    return badRequest(RECONNECT_STRIPE_OAUTH_MESSAGE);
  }

  return { kind: "ok", connection, stripeAccountId };
}

export async function resolveStripeInvoicePaidAutomationBinding(
  args: {
    readonly db: ReadonlyDb;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<StripeInvoicePaidAutomationReadinessResult> {
  const ready = await loadReadyStripeConnection(args, signal);
  if (ready.kind === "bad_request") {
    return ready;
  }
  return {
    kind: "ok",
    binding: {
      connectorId: ready.connection.connectorId,
      stripeAccountId: ready.stripeAccountId,
      mode: "live",
    },
  };
}

export async function validateStripeInvoicePaidAutomationBinding(
  args: {
    readonly db: ReadonlyDb;
    readonly eventConfig: StripeInvoicePaidEventConfig;
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<StripeInvoicePaidAutomationReadinessResult> {
  const ready = await loadReadyStripeConnection(
    {
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.eventConfig.connectorId,
    },
    signal,
  );
  if (ready.kind === "bad_request") {
    return ready;
  }
  if (ready.stripeAccountId !== args.eventConfig.stripeAccountId) {
    return { kind: "bad_request", message: STRIPE_BINDING_MISMATCH_MESSAGE };
  }
  return {
    kind: "ok",
    binding: {
      connectorId: ready.connection.connectorId,
      stripeAccountId: ready.stripeAccountId,
      mode: "live",
    },
  };
}
