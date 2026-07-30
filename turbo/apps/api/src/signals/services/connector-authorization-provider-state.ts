import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import { z } from "zod";

// #23770 accepts either single identity property until #24077 removes the
// legacy reader after the staged writer rollout.
const deviceLegacyProviderStateSchema = z
  .object({
    connectorType: connectorSlugSchema,
    connectorSlug: z.never().optional(),
    deviceCode: z.string(),
    pollState: z.string().optional(),
  })
  .transform((state) => {
    return {
      connectorSlug: state.connectorType,
      deviceCode: state.deviceCode,
      pollState: state.pollState,
    };
  });

const deviceCanonicalProviderStateSchema = z
  .object({
    connectorType: z.never().optional(),
    connectorSlug: connectorSlugSchema,
    deviceCode: z.string(),
    pollState: z.string().optional(),
  })
  .transform((state) => {
    return {
      connectorSlug: state.connectorSlug,
      deviceCode: state.deviceCode,
      pollState: state.pollState,
    };
  });

const deviceProviderStateSchema = z.union([
  deviceLegacyProviderStateSchema,
  deviceCanonicalProviderStateSchema,
]);

const externalCodeLegacyProviderStateSchema = z
  .object({
    connectorType: connectorSlugSchema,
    connectorSlug: z.never().optional(),
    authMethod: connectorAuthMethodIdSchema,
    providerState: z.string(),
  })
  .transform((state) => {
    return {
      connectorSlug: state.connectorType,
      authMethod: state.authMethod,
      providerState: state.providerState,
    };
  });

const externalCodeCanonicalProviderStateSchema = z
  .object({
    connectorType: z.never().optional(),
    connectorSlug: connectorSlugSchema,
    authMethod: connectorAuthMethodIdSchema,
    providerState: z.string(),
  })
  .transform((state) => {
    return {
      connectorSlug: state.connectorSlug,
      authMethod: state.authMethod,
      providerState: state.providerState,
    };
  });

const externalCodeProviderStateSchema = z.union([
  externalCodeLegacyProviderStateSchema,
  externalCodeCanonicalProviderStateSchema,
]);

export function parseConnectorOauthDeviceProviderState(args: {
  readonly serializedState: string;
  readonly connectorSlug: ConnectorSlug;
}) {
  const providerState = deviceProviderStateSchema.parse(
    JSON.parse(args.serializedState) as unknown,
  );
  if (providerState.connectorSlug !== args.connectorSlug) {
    throw new Error("OAuth device provider state connector type mismatch");
  }
  return providerState;
}

export function serializeConnectorOauthDeviceProviderState(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly deviceCode: string;
  readonly pollState: string | undefined;
}): string {
  // #24075 switches this legacy-only writer after the prepared reader deploys.
  return JSON.stringify({
    connectorType: args.connectorSlug,
    deviceCode: args.deviceCode,
    ...(args.pollState === undefined ? {} : { pollState: args.pollState }),
  });
}

export function parseConnectorExternalCodeProviderState(args: {
  readonly serializedState: string;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
}) {
  const providerState = externalCodeProviderStateSchema.parse(
    JSON.parse(args.serializedState) as unknown,
  );
  if (
    providerState.connectorSlug !== args.connectorSlug ||
    providerState.authMethod !== args.authMethod
  ) {
    throw new Error("External-code provider state connector method mismatch");
  }
  return providerState;
}

export function serializeConnectorExternalCodeProviderState(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly providerState: string;
}): string {
  // #24075 switches this legacy-only writer after the prepared reader deploys.
  return JSON.stringify({
    connectorType: args.connectorSlug,
    authMethod: args.authMethod,
    providerState: args.providerState,
  });
}
