import { getCustomConnector } from "../../lib/api/domains/connectors";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  connectorActionUrl,
  printCallbackActionUrlExample,
} from "./action-url";
import {
  resolveRunConnectorAccountLookups,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountLookup,
} from "./run-account-context";
import { customConnectorSettingsGuidance } from "./custom-connector-guidance";

interface CustomConnectorCheckContext {
  readonly id: string;
  readonly label: string;
  readonly definition: CustomConnectorResponse | null;
  readonly account: RunConnectorAccountLookup;
}

export async function loadCustomConnectorCheckContext(
  customConnectorId: string,
): Promise<CustomConnectorCheckContext> {
  const [definition, accounts] = await Promise.all([
    getCustomConnector(customConnectorId),
    resolveRunConnectorAccountLookups([{ kind: "custom", customConnectorId }]),
  ]);
  const account = accounts[0];
  if (!account) {
    throw new Error("Missing run account lookup for custom connector");
  }
  return {
    id: customConnectorId,
    label: definition?.displayName ?? customConnectorId,
    definition,
    account,
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
  if (
    !context.definition ||
    account.state !== "available" ||
    account.metadata.connectionStatus === "reconnect-required"
  ) {
    printCustomConnectorRecovery(context, platformOrigin, agentId);
  }
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
  const { definition, account } = context;
  if (!definition) {
    console.log(
      `Open [Custom connectors](${connectorActionUrl({ origin: platformOrigin, path: "/connectors?tab=custom", agentId })}) and select an available connector manually. Changes apply to future runs; settings review does not support callbacks.`,
    );
    return;
  }
  const path =
    account.state === "available" &&
    account.metadata.connectionStatus === "reconnect-required"
      ? `/connectors/${definition.slug}/reconnect/${account.connectionId}`
      : account.state === "not-admitted" && !definition.connected
        ? `/connectors/${definition.slug}/connect`
        : null;
  if (path === null) {
    console.log(
      customConnectorSettingsGuidance(
        context.id,
        platformOrigin,
        undefined,
        agentId,
      ),
    );
    return;
  }
  const url = connectorActionUrl({ origin: platformOrigin, path, agentId });
  console.log(
    `Open [${account.state === "available" ? "Reconnect" : "Connect"} ${context.label}](${url}). Changes apply to future runs.`,
  );
  printCallbackActionUrlExample(url, agentId);
}
