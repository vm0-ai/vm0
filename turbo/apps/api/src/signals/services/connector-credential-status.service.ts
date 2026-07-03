import { getConnectorAuthMethodAccessMetadata } from "@vm0/connectors/connector-utils";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type { ConnectorReconnectReason } from "@vm0/api-contracts/contracts/connector-schemas";

export type ConnectorCredentialStatus = "available" | "reconnect-required";

function connectorAuthMethodSupportsRefresh(
  type: ConnectorType,
  authMethod: string,
): boolean {
  return (
    getConnectorAuthMethodAccessMetadata(type, authMethod)?.kind ===
    "refresh-token"
  );
}

function connectorCredentialStatusForAccess(args: {
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
  readonly isRefreshable: boolean;
}): ConnectorCredentialStatus {
  if (args.storedNeedsReconnect) {
    return "reconnect-required";
  }
  if (args.tokenExpiresAt === null) {
    return "available";
  }
  if (args.isRefreshable) {
    return "available";
  }
  return args.tokenExpiresAt.getTime() <= args.now.getTime()
    ? "reconnect-required"
    : "available";
}

export function connectorRuntimeCredentialStatusForAccess(args: {
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
  readonly isRefreshable: boolean;
}): ConnectorCredentialStatus {
  if (args.isRefreshable) {
    return "available";
  }
  return connectorCredentialStatusForAccess(args);
}

export function connectorCredentialStatus(args: {
  readonly type: ConnectorType;
  readonly authMethod: string;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorCredentialStatus {
  return connectorCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable: connectorAuthMethodSupportsRefresh(
      args.type,
      args.authMethod,
    ),
  });
}

export function connectorCredentialReconnectReason(args: {
  readonly type: ConnectorType;
  readonly authMethod: string;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorReconnectReason | null {
  const isRefreshable = connectorAuthMethodSupportsRefresh(
    args.type,
    args.authMethod,
  );
  const credentialStatus = connectorCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable,
  });
  if (
    credentialStatus !== "reconnect-required" ||
    args.storedNeedsReconnect ||
    args.tokenExpiresAt === null ||
    isRefreshable
  ) {
    return null;
  }
  return "credential_expired";
}

export function connectorRuntimeCredentialStatus(args: {
  readonly type: ConnectorType;
  readonly authMethod: string;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly now: Date;
}): ConnectorCredentialStatus {
  return connectorRuntimeCredentialStatusForAccess({
    storedNeedsReconnect: args.storedNeedsReconnect,
    tokenExpiresAt: args.tokenExpiresAt,
    now: args.now,
    isRefreshable: connectorAuthMethodSupportsRefresh(
      args.type,
      args.authMethod,
    ),
  });
}
