import type { ConnectorDiscoveryAgentContext } from "./agent-context";
import {
  connectorActionUrl,
  currentChatSupportsActionCallback,
  finalizeActionUrl,
} from "./action-url";
import {
  isConnectorDiscoveryAuthorized,
  type ConnectorDiscoveryDefinition,
  type ConnectorDiscoveryItem,
} from "./discovery";
import type { RunConnectorAccountLookup } from "./run-account-context";
import { customConnectorSettingsPath } from "./custom-connector-guidance";

export interface ConnectorSearchAction {
  readonly label: string;
  readonly path: string;
  readonly supportsCallback: boolean;
  readonly guidance?: string;
}

type ConnectorSearchTarget =
  | Pick<
      Extract<ConnectorDiscoveryDefinition, { kind: "catalog" }>,
      "kind" | "slug" | "label"
    >
  | Pick<
      Extract<ConnectorDiscoveryDefinition, { kind: "custom" }>,
      "kind" | "slug" | "label" | "customConnector"
    >;

function accountSettingsAction(
  connector: ConnectorSearchTarget,
): ConnectorSearchAction {
  return {
    label: `Review ${connector.label} accounts and agent access`,
    path:
      connector.kind === "custom"
        ? customConnectorSettingsPath(connector.customConnector.id, "accounts")
        : "/connectors",
    supportsCallback: false,
  };
}

function connectionAction(
  connector: ConnectorSearchTarget,
  authorized: boolean | null,
  action: Pick<ConnectorSearchAction, "label" | "path">,
): ConnectorSearchAction {
  if (
    connector.kind === "custom" &&
    connector.customConnector.permissionBundleRef &&
    authorized !== true
  ) {
    return {
      ...action,
      supportsCallback: false,
      guidance:
        "This connector requires a separate Agent permission review, so this connection does not support --callback-prompt. Connect or reconnect the account, then review Agent access in Connectors settings and continue manually. Changes apply to future runs.",
    };
  }
  return {
    ...action,
    supportsCallback: true,
  };
}

export function connectorConnectAction(
  connector: ConnectorSearchTarget,
  authorized: boolean | null,
): ConnectorSearchAction {
  return connectionAction(connector, authorized, {
    label: `Connect or authorize ${connector.label}`,
    path: `/connectors/${connector.slug}/connect`,
  });
}

function customAccessAction(
  connector: Extract<ConnectorSearchTarget, { kind: "custom" }>,
): ConnectorSearchAction {
  return {
    label: `Review ${connector.label} agent access`,
    path: customConnectorSettingsPath(connector.customConnector.id, "access"),
    supportsCallback: false,
  };
}

export function runConnectorSearchAction(
  connector: ConnectorSearchTarget,
  lookup: RunConnectorAccountLookup,
  authorized: boolean | null,
): ConnectorSearchAction | null {
  switch (lookup.state) {
    case "available":
      if (lookup.metadata.connectionStatus !== "reconnect-required") {
        return connector.kind === "custom" && authorized === false
          ? customAccessAction(connector)
          : null;
      }
      return connectionAction(connector, authorized, {
        label: `Reconnect ${connector.label} (${lookup.label})`,
        path: `/connectors/${connector.slug}/reconnect/${lookup.connectionId}`,
      });
    case "not-admitted":
      if (connector.kind === "custom" && connector.customConnector.connected) {
        return authorized === false
          ? customAccessAction(connector)
          : accountSettingsAction(connector);
      }
      return connectorConnectAction(connector, authorized);
    case "metadata-unavailable":
    case "context-unavailable":
      return accountSettingsAction(connector);
  }
}

export function currentConnectorSearchAction(
  connector: ConnectorDiscoveryItem,
  agentContext: ConnectorDiscoveryAgentContext | null,
): ConnectorSearchAction | null {
  const authorized = agentContext
    ? isConnectorDiscoveryAuthorized(connector, agentContext)
    : null;
  if (connector.kind === "custom") {
    if (!connector.customConnector.connected) {
      return connectorConnectAction(connector, authorized);
    }
    return authorized === false ? customAccessAction(connector) : null;
  }
  if (connector.catalogConnector.connectionStatus === "reconnect-required") {
    return accountSettingsAction(connector);
  }
  if (!connector.catalogConnector.connected) {
    return connectorConnectAction(connector, authorized);
  }
  return authorized !== false
    ? null
    : {
        label: `Authorize ${connector.label}`,
        path: `/connectors/${connector.slug}/authorize`,
        supportsCallback: true,
      };
}

export function connectorSearchActionLinks(args: {
  readonly actions: readonly ConnectorSearchAction[];
  readonly origin: string;
  readonly agentId: string | undefined;
  readonly callbackPrompt: string | undefined;
}) {
  return args.actions.map((action) => {
    if (args.callbackPrompt !== undefined && !action.supportsCallback) {
      throw new Error(
        action.guidance ??
          "This connector needs an account or access review in Connectors settings, which does not support --callback-prompt.",
      );
    }
    const url = connectorActionUrl({
      origin: args.origin,
      path: action.path,
      agentId: args.agentId,
    });
    return {
      label: action.label,
      url: finalizeActionUrl(new URL(url), args.callbackPrompt, args.agentId),
      supportsCallback: action.supportsCallback,
      ...(action.guidance ? { guidance: action.guidance } : {}),
    };
  });
}

export function printConnectorSearchGuidance(args: {
  readonly actions: readonly ConnectorSearchAction[];
  readonly origin: string;
  readonly agentId: string | undefined;
  readonly runBound: boolean;
  readonly callbackPrompt: string | undefined;
}): void {
  if (args.actions.length === 0) {
    return;
  }
  const links = connectorSearchActionLinks(args);

  console.log("");
  console.log("Connection context:");
  console.log(
    "These services are supported by Okou. When a service is needed for the user's task, the connection links below let you help the user connect or authorize it now. The user completes sign-in or approval in Okou; credentials stay out of chat and private files can remain private.",
  );
  if (args.runBound) {
    console.log(
      '"Not admitted" means no account was selected for this run; it does not establish whether the user already has a connected account. Connector changes apply to future runs. The command okou connector account list <slug> --json shows existing account IDs, and okou connector account switch-request --help describes selecting one for this chat.',
    );
  }
  for (const link of links) {
    console.log(`  [${link.label}](${link.url})`);
    if (link.guidance) {
      console.log(`  ${link.guidance}`);
    }
  }

  if (args.callbackPrompt !== undefined) {
    console.log(
      "This link starts the next round in the current chat with the supplied prompt after the user completes the action. The current turn can end after sharing the exact link, including all query parameters; the connection is pending until the user completes it.",
    );
  } else if (
    currentChatSupportsActionCallback(args.agentId) &&
    args.actions.some((action) => {
      return action.supportsCallback;
    })
  ) {
    console.log(
      'When only one connector or permission action is needed, okou connector search <slug> --limit 1 --callback-prompt "<original task and next step>" provides a link that continues this chat after the user completes the action. The prompt is included in the URL, so a short task description without secrets is sufficient. Ordinary links support tasks that need multiple access actions.',
    );
  }
}
