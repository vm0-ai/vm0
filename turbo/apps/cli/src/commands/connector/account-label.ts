import {
  connectorAccountEffectiveLabel,
  connectorAccountExternalIdentity,
  type ConnectorAccountIdentityFields,
} from "@okouai/api-contracts/contracts/connector-accounts";

interface ConnectorAccountCliLabelInput extends ConnectorAccountIdentityFields {
  readonly connectionId: string;
}

function connectorAccountCliExternalIdentity(
  account: ConnectorAccountIdentityFields,
): string | null {
  const identity = connectorAccountExternalIdentity(account);
  if (
    identity &&
    identity === account.externalUsername &&
    !account.externalEmail
  ) {
    return `@${identity}`;
  }
  return identity;
}

export function connectorAccountCliLabel(
  account: ConnectorAccountCliLabelInput,
): string {
  const fallbackLabel = `Account #${account.connectionId.slice(0, 8)}`;
  if (account.displayName) {
    return connectorAccountEffectiveLabel(account, fallbackLabel);
  }
  return connectorAccountCliExternalIdentity(account) ?? fallbackLabel;
}

export function connectorAccountCliInventoryLabel(
  account: ConnectorAccountCliLabelInput,
): string {
  const label = connectorAccountCliLabel(account);
  const identity = connectorAccountCliExternalIdentity(account);
  if (account.displayName && identity && identity !== account.displayName) {
    return `${label} (${identity})`;
  }
  return label;
}
