import { getCustomConnector } from "../../lib/api/domains/connectors";
import { getAgentCustomConnectorGrants } from "../../lib/api/domains/agents";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  connectorActionUrl,
  printCallbackActionUrlExample,
} from "./action-url";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountLookup,
} from "./run-account-context";
import {
  connectorConnectAction,
  runConnectorSearchAction,
} from "./search-guidance";

interface CustomConnectorCheckContext {
  readonly label: string;
  readonly definition: CustomConnectorResponse | null;
  readonly account: RunConnectorAccountLookup | null;
  readonly authorized: boolean | null;
}

export async function loadCustomConnectorCheckContext(
  customConnectorId: string,
  agentId: string | undefined,
): Promise<CustomConnectorCheckContext> {
  const [definition, accounts, grants] = await Promise.all([
    getCustomConnector(customConnectorId),
    isRunBoundConnectorContext()
      ? resolveRunConnectorAccountLookups([
          { kind: "custom", customConnectorId },
        ])
      : null,
    agentId ? getAgentCustomConnectorGrants(agentId) : null,
  ]);
  const account = accounts === null ? null : accounts[0];
  if (account === undefined) {
    throw new Error("Missing run account lookup for custom connector");
  }
  return {
    label: definition?.displayName ?? customConnectorId,
    definition,
    account,
    authorized:
      grants === null
        ? null
        : grants.some((grant) => {
            return grant.customConnectorId === customConnectorId;
          }),
  };
}

export function printCustomConnectorCheckStatus(
  context: CustomConnectorCheckContext,
  platformOrigin: string,
  agentId: string | undefined,
): void {
  console.log("## Step 2: Custom connector configuration");
  console.log("");
  if (!context.definition) {
    console.log("Current custom connector metadata is unavailable or deleted.");
  }
  const account = context.account;
  if (account === null) {
    if (context.definition) {
      console.log(
        `Current organization connection: ${context.definition.connected ? "connected" : "not connected"}.`,
      );
    }
  } else {
    switch (account.state) {
      case "context-unavailable":
        console.log(runConnectorAccountUnavailableMessage(account.reason));
        break;
      case "not-admitted":
        console.log(`No ${context.label} account was admitted for this run.`);
        console.log("Select an available account, then start a new run.");
        break;
      case "metadata-unavailable":
        console.log(`Account used by this run: ${account.connectionId}`);
        console.log("Current account metadata is unavailable or deleted.");
        console.log("Select an available account, then start a new run.");
        break;
      case "available":
        console.log(`Account used by this run: ${account.label}`);
        console.log(`Connection ID: ${account.connectionId}`);
        if (account.metadata.connectionStatus === "reconnect-required") {
          console.log(
            "The account selected for this run needs to be reconnected.",
          );
          console.log("After reconnecting, start a new run.");
        } else {
          console.log("The account selected for this run is connected.");
        }
        break;
    }
  }
  if (context.definition && context.authorized !== null) {
    console.log(
      `${context.label} is ${context.authorized ? "authorized" : "not authorized"} for this agent (${agentId}).`,
    );
  }
  printCustomConnectorRecovery(context, platformOrigin, agentId);
  console.log(
    "Routing and permission diagnostics describe current intended state; they do not confirm that the runner has applied the latest update.",
  );
  console.log("");
}

function printCustomConnectorRecovery(
  context: CustomConnectorCheckContext,
  platformOrigin: string,
  agentId: string | undefined,
): void {
  const { definition, account, authorized } = context;
  if (!definition) {
    console.log(
      `Open [Custom connectors](${connectorActionUrl({ origin: platformOrigin, path: "/connectors?tab=custom", agentId })}) and select an available connector manually. Changes apply to future runs; settings review does not support callbacks.`,
    );
    return;
  }
  const action =
    account !== null
      ? runConnectorSearchAction(
          {
            kind: "custom",
            slug: definition.slug,
            label: context.label,
            customConnector: definition,
          },
          account,
          authorized,
        )
      : !definition.connected
        ? connectorConnectAction(
            {
              kind: "custom",
              slug: definition.slug,
              label: context.label,
              customConnector: definition,
            },
            authorized,
          )
        : null;
  if (action === null) {
    return;
  }
  const url = connectorActionUrl({
    origin: platformOrigin,
    path: action.path,
    agentId,
  });
  if (!action.supportsCallback) {
    console.log(`Open [${action.label}](${url}).`);
    console.log(
      action.guidance ??
        "Settings review does not support callbacks. Opening this link does not grant access or select an account. Connection and selection changes apply to future runs.",
    );
    return;
  }
  console.log(
    `Open [${account?.state === "available" ? "Reconnect" : "Connect"} ${context.label}](${url}). Changes apply to future runs.`,
  );
  printCallbackActionUrlExample(url, agentId);
}
