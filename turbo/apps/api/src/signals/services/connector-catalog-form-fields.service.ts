import type {
  ConnectorAuthMethodRuntimeConfig,
  ConnectorDeviceAuthStartOptionConfig,
  ConnectorDeviceAuthStartOptions,
  ConnectorDeviceAuthStartOptionsConfig,
} from "@vm0/connectors/connector-config";
import { parseConnectorDeviceAuthStartOptionsConfig } from "@vm0/connectors/connector-auth-method";

interface PublicManualGrantFieldDescriptor {
  readonly publicId: string;
  readonly privateName: string;
}

interface PublicDeviceAuthStartOptionDescriptor {
  readonly publicId: string;
  readonly privateName: string;
  readonly config: ConnectorDeviceAuthStartOptionConfig;
}

type ManualGrantSubmittedValuesNormalizationResult =
  | {
      readonly ok: true;
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly message: string };

type DeviceAuthStartOptionsNormalizationResult =
  | {
      readonly ok: true;
      readonly options: ConnectorDeviceAuthStartOptions;
    }
  | { readonly ok: false; readonly message: string };

function formatFieldList(names: readonly string[]): string {
  return [...names].sort().join(", ");
}

function publicManualGrantFieldDescriptors(
  grant: Extract<
    ConnectorAuthMethodRuntimeConfig["grant"],
    { readonly kind: "manual" }
  >,
): readonly PublicManualGrantFieldDescriptor[] {
  return Object.entries(grant.fields).map(([privateName, config]) => {
    return {
      publicId: config.publicId,
      privateName,
    };
  });
}

function publicDeviceAuthStartOptionDescriptors(
  grant: Extract<
    ConnectorAuthMethodRuntimeConfig["grant"],
    { readonly kind: "device-auth" }
  >,
): readonly PublicDeviceAuthStartOptionDescriptor[] {
  return Object.entries(grant.startOptions ?? {}).map(
    ([privateName, config]) => {
      return {
        publicId: config.publicId,
        privateName,
        config,
      };
    },
  );
}

export function normalizeManualGrantSubmittedValuesWithMethod(args: {
  readonly connectorRef: string;
  readonly authMethodId: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly values: Readonly<Record<string, string>>;
}): ManualGrantSubmittedValuesNormalizationResult {
  const descriptors =
    args.method.grant.kind === "manual"
      ? publicManualGrantFieldDescriptors(args.method.grant)
      : null;
  return normalizeManualGrantSubmittedValuesFromDescriptors({
    connectorRef: args.connectorRef,
    authMethodId: args.authMethodId,
    descriptors,
    values: args.values,
  });
}

function normalizeManualGrantSubmittedValuesFromDescriptors(args: {
  readonly connectorRef: string;
  readonly authMethodId: string;
  readonly descriptors: readonly PublicManualGrantFieldDescriptor[] | null;
  readonly values: Readonly<Record<string, string>>;
}): ManualGrantSubmittedValuesNormalizationResult {
  const descriptors = args.descriptors;
  if (!descriptors) {
    return {
      ok: false,
      message: `${args.connectorRef} ${args.authMethodId} auth method does not use a manual grant`,
    };
  }

  const descriptorByPublicId = new Map(
    descriptors.map((descriptor) => {
      return [descriptor.publicId, descriptor];
    }),
  );
  const normalizedValues = new Map<string, string>();
  const unknownNames: string[] = [];

  for (const [submittedName, value] of Object.entries(args.values)) {
    const descriptor = descriptorByPublicId.get(submittedName);
    if (!descriptor) {
      unknownNames.push(submittedName);
      continue;
    }

    normalizedValues.set(descriptor.privateName, value);
  }

  if (unknownNames.length > 0) {
    return {
      ok: false,
      message: `Unknown manual grant field(s). Expected: ${formatFieldList(
        descriptors.map((descriptor) => {
          return descriptor.publicId;
        }),
      )}`,
    };
  }

  return {
    ok: true,
    values: Object.fromEntries(normalizedValues),
  };
}

export function normalizeDeviceAuthStartOptionsWithMethod(args: {
  readonly authMethodId: string;
  readonly connectorRef: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly options: ConnectorDeviceAuthStartOptions | undefined;
}): DeviceAuthStartOptionsNormalizationResult {
  const descriptors =
    args.method.grant.kind === "device-auth"
      ? publicDeviceAuthStartOptionDescriptors(args.method.grant)
      : null;
  return normalizeDeviceAuthStartOptionsFromDescriptors({
    authMethodId: args.authMethodId,
    connectorRef: args.connectorRef,
    descriptors,
    options: args.options,
  });
}

function normalizeDeviceAuthStartOptionsFromDescriptors(args: {
  readonly authMethodId: string;
  readonly connectorRef: string;
  readonly descriptors: readonly PublicDeviceAuthStartOptionDescriptor[] | null;
  readonly options: ConnectorDeviceAuthStartOptions | undefined;
}): DeviceAuthStartOptionsNormalizationResult {
  const descriptors = args.descriptors;
  if (!descriptors) {
    return {
      ok: false,
      message: `${args.connectorRef} ${args.authMethodId} auth method does not use a device-auth grant`,
    };
  }

  const startOptionsByPublicId: ConnectorDeviceAuthStartOptionsConfig =
    Object.fromEntries(
      descriptors.map((descriptor) => {
        return [descriptor.publicId, descriptor.config];
      }),
    );
  const hasUnknownName = Object.keys(args.options ?? {}).some((name) => {
    return !Object.hasOwn(startOptionsByPublicId, name);
  });
  if (hasUnknownName && descriptors.length > 0) {
    return {
      ok: false,
      message: `${args.connectorRef} ${args.authMethodId} device-auth start option(s) must use public IDs: ${formatFieldList(
        descriptors.map((descriptor) => {
          return descriptor.publicId;
        }),
      )}`,
    };
  }

  const parsed = parseConnectorDeviceAuthStartOptionsConfig({
    connectorRef: args.connectorRef,
    authMethodId: args.authMethodId,
    startOptions: startOptionsByPublicId,
    options: args.options,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.message };
  }

  const normalizedOptions: Record<string, string> = {};
  for (const descriptor of descriptors) {
    const value = parsed.options[descriptor.publicId];
    if (value !== undefined) {
      normalizedOptions[descriptor.privateName] = value;
    }
  }
  return { ok: true, options: normalizedOptions };
}
