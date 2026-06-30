import type {
  ConnectorAuthMethodId,
  ConnectorDeviceAuthStartOptionConfig,
  ConnectorDeviceAuthStartOptions,
  ConnectorManualGrantFieldConfig,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { getConnectorAuthMethod } from "@vm0/connectors/connector-utils";

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
      readonly usesPublicIds: boolean;
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
  authMethod: ConnectorAuthMethodId,
): readonly PublicManualGrantFieldDescriptor[] | null {
  const method = getConnectorAuthMethod(type, authMethod);
  if (method?.grant.kind !== "manual") {
    return null;
  }
  return Object.entries(method.grant.fields).map(([privateName, config]) => {
    return {
      publicId: config.publicId,
      privateName,
      config,
    };
  });
}

export function getPublicDeviceAuthStartOptionDescriptors(
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): readonly PublicDeviceAuthStartOptionDescriptor[] | null {
  const method = getConnectorAuthMethod(type, authMethod);
  if (method?.grant.kind !== "device-auth") {
    return null;
  }
  return Object.entries(method.grant.startOptions ?? {}).map(
    ([privateName, config]) => {
      return {
        publicId: config.publicId,
        privateName,
        config,
      };
    },
  );
}

export function normalizeManualGrantSubmittedValues(args: {
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly values: Readonly<Record<string, string>>;
}): ManualGrantSubmittedValuesNormalizationResult {
  const descriptors = getPublicManualGrantFieldDescriptors(
    args.type,
    args.authMethod,
  );
  if (!descriptors) {
    return {
      ok: false,
      message: `${args.type} ${args.authMethod} auth method does not use a manual grant`,
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
  const normalizedValues: Record<string, string> = {};
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
    normalizedValues[descriptor.privateName] = value;
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
    values: normalizedValues,
    usesPublicIds,
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

export function normalizeDeviceAuthStartOptions(args: {
  readonly type: ConnectorType;
  readonly authMethod: ConnectorAuthMethodId;
  readonly options: ConnectorDeviceAuthStartOptions | undefined;
}): DeviceAuthStartOptionsNormalizationResult {
  if (!args.options) {
    return { ok: true, options: undefined };
  }

  const descriptors = getPublicDeviceAuthStartOptionDescriptors(
    args.type,
    args.authMethod,
  );
  if (!descriptors || descriptors.length === 0) {
    return { ok: true, options: args.options };
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
  const normalizedOptions: Record<string, string> = {};
  const seenPrivateNames = new Set<string>();
  const ambiguousPublicNames: string[] = [];

  for (const [submittedName, value] of Object.entries(args.options)) {
    const publicDescriptor = descriptorByPublicId.get(submittedName);
    const legacyDescriptor = descriptorByPrivateName.get(submittedName);
    const descriptor = publicDescriptor ?? legacyDescriptor;

    if (!descriptor) {
      normalizedOptions[submittedName] = value;
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
    normalizedOptions[descriptor.privateName] = value;
  }

  if (ambiguousPublicNames.length > 0) {
    return {
      ok: false,
      message: `Ambiguous device-auth start option(s): ${formatPublicFieldList(
        ambiguousPublicNames,
      )}`,
    };
  }

  return { ok: true, options: normalizedOptions };
}
