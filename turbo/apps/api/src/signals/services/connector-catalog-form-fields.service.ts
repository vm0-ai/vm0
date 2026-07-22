import type {
  ConnectorRegistryAuthMethodId,
  ConnectorAuthMethodRuntimeConfig,
  ConnectorDeviceAuthStartOptionConfig,
  ConnectorDeviceAuthStartOptions,
  ConnectorDeviceAuthStartOptionsConfig,
  ConnectorManualGrantFieldConfig,
  ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getConnectorAuthMethod,
  parseConnectorDeviceAuthStartOptionsConfig,
} from "@vm0/connectors/connector-utils";

interface PublicManualGrantFieldDescriptor {
  readonly publicId: string;
  readonly privateName: string;
  readonly config: ConnectorManualGrantFieldConfig;
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
      readonly errorNamesByPrivateName: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly message: string };

type DeviceAuthStartOptionsNormalizationResult =
  | {
      readonly ok: true;
      readonly options: ConnectorDeviceAuthStartOptions | undefined;
    }
  | { readonly ok: false; readonly message: string };

function formatPublicFieldList(names: readonly string[]): string {
  return [...names].sort().join(", ");
}

export function getPublicManualGrantFieldDescriptors(
  type: ConnectorType,
  authMethod: ConnectorRegistryAuthMethodId,
): readonly PublicManualGrantFieldDescriptor[] | null {
  const method = getConnectorAuthMethod(type, authMethod);
  if (method?.grant.kind !== "manual") {
    return null;
  }
  return publicManualGrantFieldDescriptors(method.grant);
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
      config,
    };
  });
}

export function getPublicDeviceAuthStartOptionDescriptors(
  type: ConnectorType,
  authMethod: ConnectorRegistryAuthMethodId,
): readonly PublicDeviceAuthStartOptionDescriptor[] | null {
  const method = getConnectorAuthMethod(type, authMethod);
  if (method?.grant.kind !== "device-auth") {
    return null;
  }
  return publicDeviceAuthStartOptionDescriptors(method.grant);
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
  const descriptorByPrivateName = new Map(
    descriptors.map((descriptor) => {
      return [descriptor.privateName, descriptor];
    }),
  );
  const normalizedValues = new Map<string, string>();
  const seenPrivateNames = new Set<string>();
  const unknownNames: string[] = [];
  const ambiguousPublicNames: string[] = [];
  let usesPublicIds = false;

  for (const [submittedName, value] of Object.entries(args.values)) {
    const publicDescriptor = descriptorByPublicId.get(submittedName);
    const legacyDescriptor = descriptorByPrivateName.get(submittedName);
    const descriptor = publicDescriptor ?? legacyDescriptor;

    if (!descriptor) {
      unknownNames.push(submittedName);
      continue;
    }

    if (
      publicDescriptor &&
      legacyDescriptor &&
      publicDescriptor.privateName !== legacyDescriptor.privateName
    ) {
      usesPublicIds = true;
      ambiguousPublicNames.push(publicDescriptor.publicId);
      continue;
    }

    if (publicDescriptor) {
      usesPublicIds = true;
    }

    if (seenPrivateNames.has(descriptor.privateName)) {
      ambiguousPublicNames.push(descriptor.publicId);
      continue;
    }

    seenPrivateNames.add(descriptor.privateName);
    normalizedValues.set(descriptor.privateName, value);
  }

  if (unknownNames.length > 0) {
    return {
      ok: false,
      message: `Unknown manual grant field(s): ${formatPublicFieldList(
        unknownNames,
      )}`,
    };
  }

  if (ambiguousPublicNames.length > 0) {
    return {
      ok: false,
      message: `Ambiguous manual grant field(s): ${formatPublicFieldList(
        ambiguousPublicNames,
      )}`,
    };
  }

  return {
    ok: true,
    values: Object.fromEntries(normalizedValues),
    errorNamesByPrivateName: Object.fromEntries(
      descriptors.map((descriptor) => {
        return [
          descriptor.privateName,
          usesPublicIds ? descriptor.publicId : descriptor.privateName,
        ];
      }),
    ),
  };
}

export function normalizeDeviceAuthStartOptionsWithMethod(args: {
  readonly authMethodId: string;
  readonly connectorRef: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly options: ConnectorDeviceAuthStartOptions | undefined;
}): DeviceAuthStartOptionsNormalizationResult {
  if (!args.options) {
    return { ok: true, options: undefined };
  }
  const descriptors =
    args.method.grant.kind === "device-auth"
      ? publicDeviceAuthStartOptionDescriptors(args.method.grant)
      : null;
  return normalizeDeviceAuthStartOptionsFromDescriptors({
    authMethodId: args.authMethodId,
    connectorRef: args.connectorRef,
    descriptors,
    startOptions:
      args.method.grant.kind === "device-auth"
        ? args.method.grant.startOptions
        : undefined,
    options: args.options,
  });
}

function normalizeDeviceAuthStartOptionsFromDescriptors(args: {
  readonly authMethodId: string;
  readonly connectorRef: string;
  readonly descriptors: readonly PublicDeviceAuthStartOptionDescriptor[] | null;
  readonly options: ConnectorDeviceAuthStartOptions | undefined;
  readonly startOptions: ConnectorDeviceAuthStartOptionsConfig | undefined;
}): DeviceAuthStartOptionsNormalizationResult {
  if (!args.options) {
    return { ok: true, options: undefined };
  }
  const descriptors = args.descriptors;
  if (!descriptors) {
    return {
      ok: false,
      message: `${args.connectorRef} ${args.authMethodId} auth method does not use a device-auth grant`,
    };
  }

  const descriptorByPublicId = new Map(
    descriptors.map((descriptor) => {
      return [descriptor.publicId, descriptor];
    }),
  );
  const descriptorByPrivateName = new Map(
    descriptors.map((descriptor) => {
      return [descriptor.privateName, descriptor];
    }),
  );
  const normalizedOptions = new Map<string, string>();
  const seenPrivateNames = new Set<string>();
  const ambiguousPublicNames: string[] = [];

  for (const [submittedName, value] of Object.entries(args.options)) {
    const publicDescriptor = descriptorByPublicId.get(submittedName);
    const legacyDescriptor = descriptorByPrivateName.get(submittedName);
    const descriptor = publicDescriptor ?? legacyDescriptor;

    if (!descriptor) {
      normalizedOptions.set(submittedName, value);
      continue;
    }

    if (
      publicDescriptor &&
      legacyDescriptor &&
      publicDescriptor.privateName !== legacyDescriptor.privateName
    ) {
      ambiguousPublicNames.push(publicDescriptor.publicId);
      continue;
    }

    if (seenPrivateNames.has(descriptor.privateName)) {
      ambiguousPublicNames.push(descriptor.publicId);
      continue;
    }

    seenPrivateNames.add(descriptor.privateName);
    normalizedOptions.set(descriptor.privateName, value);
  }

  if (ambiguousPublicNames.length > 0) {
    return {
      ok: false,
      message: `Ambiguous device-auth start option(s): ${formatPublicFieldList(
        ambiguousPublicNames,
      )}`,
    };
  }

  const parsed = parseConnectorDeviceAuthStartOptionsConfig({
    connectorRef: args.connectorRef,
    authMethodId: args.authMethodId,
    startOptions: args.startOptions,
    options: Object.fromEntries(normalizedOptions),
  });
  return parsed.success
    ? { ok: true, options: parsed.options }
    : { ok: false, message: parsed.message };
}
