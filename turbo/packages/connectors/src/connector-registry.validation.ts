import type {
  ConnectorConfig,
  ConnectorPlatformSecretName,
  ConnectorStorageConfig,
} from "./connector-config";
import type { CONNECTOR_TYPES } from "./connectors";

type ConnectorStorageSecretName<Storage> = Storage extends {
  readonly secrets: readonly (infer Name)[];
}
  ? Extract<Name, string>
  : never;

type ConnectorStorageVariableName<Storage> = Storage extends {
  readonly variables: readonly (infer Name)[];
}
  ? Extract<Name, string>
  : never;

type ConnectorAccessPlatformSecretName<Access> = Access extends {
  readonly platformSecrets: readonly (infer Name)[];
}
  ? Extract<Name, ConnectorPlatformSecretName>
  : never;

type ConnectorRuntimeValueRef<Storage, Access> =
  | `$secrets.${ConnectorStorageSecretName<Storage> | ConnectorAccessPlatformSecretName<Access>}`
  | `$vars.${ConnectorStorageVariableName<Storage>}`;

type ConnectorRefreshInputValueRef<Storage> =
  | `$secrets.${ConnectorStorageSecretName<Storage>}`
  | `$vars.${ConnectorStorageVariableName<Storage>}`;

type ConnectorStorageOutputValueRef<Storage> =
  | `$secrets.${ConnectorStorageSecretName<Storage>}`
  | `$vars.${ConnectorStorageVariableName<Storage>}`;

type ConnectorRevokeInputValueRef<Storage> =
  `$secrets.${ConnectorStorageSecretName<Storage>}`;

type RejectLegacyConnectorEnvBindingRequired<Binding> = Binding extends {
  readonly required: unknown;
}
  ? never
  : Binding;

type ValidatedConnectorEnvBindingValue<Binding, Storage, Access> =
  Binding extends { readonly valueRef: infer ValueRef }
    ? RejectLegacyConnectorEnvBindingRequired<Binding> & {
        readonly valueRef: ValueRef extends ConnectorRuntimeValueRef<
          Storage,
          Access
        >
          ? ValueRef
          : ConnectorRuntimeValueRef<Storage, Access>;
      }
    : Binding extends ConnectorRuntimeValueRef<Storage, Access>
      ? Binding
      : ConnectorRuntimeValueRef<Storage, Access>;

type ValidatedConnectorEnvBindings<EnvBindings, Storage, Access> = {
  readonly [EnvName in keyof EnvBindings]: ValidatedConnectorEnvBindingValue<
    EnvBindings[EnvName],
    Storage,
    Access
  >;
};

type ValidatedConnectorRefreshInputs<Inputs, Storage> = {
  readonly [InputName in keyof Inputs]: Inputs[InputName] extends ConnectorRefreshInputValueRef<Storage>
    ? Inputs[InputName]
    : ConnectorRefreshInputValueRef<Storage>;
};

type ValidatedConnectorRefreshOutputs<Outputs, Storage> = {
  readonly [OutputName in keyof Outputs]: Outputs[OutputName] extends ConnectorStorageOutputValueRef<Storage>
    ? Outputs[OutputName]
    : ConnectorStorageOutputValueRef<Storage>;
};

type ValidatedConnectorGrantOutputs<Outputs, Storage> = {
  readonly [OutputName in keyof Outputs]: Outputs[OutputName] extends ConnectorStorageOutputValueRef<Storage>
    ? Outputs[OutputName]
    : ConnectorStorageOutputValueRef<Storage>;
};

type ValidatedConnectorRevokeInputs<Inputs, Storage> = {
  readonly [InputName in keyof Inputs]: Inputs[InputName] extends ConnectorRevokeInputValueRef<Storage>
    ? Inputs[InputName]
    : ConnectorRevokeInputValueRef<Storage>;
};

type ConnectorRefreshOutputSecretName<Outputs> =
  Outputs[keyof Outputs] extends infer Ref
    ? Ref extends `$secrets.${infer Name}`
      ? Name
      : never
    : never;

type ValidatedConnectorRefreshableSecrets<Secrets, Outputs> =
  Secrets extends readonly unknown[]
    ? {
        readonly [Index in keyof Secrets]: Secrets[Index] extends ConnectorRefreshOutputSecretName<Outputs>
          ? Secrets[Index]
          : ConnectorRefreshOutputSecretName<Outputs>;
      }
    : readonly ConnectorRefreshOutputSecretName<Outputs>[];

type ValidatedConnectorRefreshTokenAccessConfig<Access, Storage> =
  Access extends {
    readonly inputs: infer Inputs;
    readonly outputs: infer Outputs;
    readonly refreshableSecrets: infer RefreshableSecrets;
  }
    ? Access & {
        readonly inputs: ValidatedConnectorRefreshInputs<Inputs, Storage>;
        readonly outputs: ValidatedConnectorRefreshOutputs<Outputs, Storage>;
        readonly refreshableSecrets: ValidatedConnectorRefreshableSecrets<
          RefreshableSecrets,
          Outputs
        >;
      }
    : never;

type ValidatedConnectorAccessConfig<Access, Storage> = Access extends {
  readonly envBindings: infer EnvBindings;
}
  ? Access extends {
      readonly kind: "refresh-token";
    }
    ? ValidatedConnectorRefreshTokenAccessConfig<Access, Storage> & {
        readonly envBindings: ValidatedConnectorEnvBindings<
          EnvBindings,
          Storage,
          Access
        >;
      }
    : Access & {
        readonly envBindings: ValidatedConnectorEnvBindings<
          EnvBindings,
          Storage,
          Access
        >;
      }
  : Access;

type ValidatedConnectorManualGrantField<
  Field,
  FieldName extends string,
  Storage,
> =
  FieldName extends ConnectorStorageSecretName<Storage>
    ? Field extends { readonly storage: "variable" }
      ? never
      : Field
    : FieldName extends ConnectorStorageVariableName<Storage>
      ? Field extends { readonly storage: "variable" }
        ? Field
        : never
      : never;

type ValidatedConnectorGrantConfig<Grant, Storage> = Grant extends {
  readonly kind: "manual";
  readonly fields: infer Fields;
}
  ? Grant & {
      readonly fields: {
        readonly [FieldName in keyof Fields]: FieldName extends string
          ? ValidatedConnectorManualGrantField<
              Fields[FieldName],
              FieldName,
              Storage
            >
          : never;
      };
    }
  : Grant extends {
        readonly kind:
          | "auth-code"
          | "openid-auth"
          | "external-code"
          | "device-auth";
        readonly outputs: infer Outputs;
      }
    ? Grant & {
        readonly outputs: ValidatedConnectorGrantOutputs<Outputs, Storage>;
      } & ValidatedConnectorDeviceAuthStartOptions<Grant>
    : Grant;

type ConnectorDeviceAuthStartSelectOptionValue<Option> = Option extends {
  readonly options: readonly (infer Choice)[];
}
  ? Choice extends { readonly value: infer Value }
    ? Value
    : never
  : never;

type ValidatedConnectorDeviceAuthStartOption<Option> = Option extends {
  readonly kind: "select";
  readonly defaultValue: infer DefaultValue;
}
  ? DefaultValue extends ConnectorDeviceAuthStartSelectOptionValue<Option>
    ? Option
    : never
  : Option;

type ValidatedConnectorDeviceAuthStartOptionMap<Options> = {
  readonly [OptionName in keyof Options]: ValidatedConnectorDeviceAuthStartOption<
    Options[OptionName]
  >;
};

type ValidatedConnectorDeviceAuthStartOptions<Grant> = Grant extends {
  readonly kind: "device-auth";
  readonly startOptions: infer StartOptions;
}
  ? {
      readonly startOptions: ValidatedConnectorDeviceAuthStartOptionMap<StartOptions>;
    }
  : object;

type ValidatedConnectorRevokeConfig<Revoke, Storage> = Revoke extends {
  readonly kind: "token-revoke";
  readonly inputs: infer Inputs;
}
  ? Revoke & {
      readonly inputs: ValidatedConnectorRevokeInputs<Inputs, Storage>;
    }
  : Revoke;

type ValidatedConnectorAuthMethod<Method> = Method extends {
  readonly storage: infer Storage;
  readonly grant: infer Grant;
  readonly access: infer Access;
  readonly revoke: infer Revoke;
}
  ? Method & {
      readonly storage: Storage & ConnectorStorageConfig;
      readonly grant: ValidatedConnectorGrantConfig<Grant, Storage>;
      readonly access: ValidatedConnectorAccessConfig<Access, Storage>;
      readonly revoke: ValidatedConnectorRevokeConfig<Revoke, Storage>;
    }
  : never;

type ValidatedConnectorConfig<Config> = Config extends {
  readonly authMethods: infer AuthMethods;
}
  ? Config & {
      readonly authMethods: {
        readonly [Method in keyof AuthMethods]: ValidatedConnectorAuthMethod<
          AuthMethods[Method]
        >;
      };
    }
  : never;

type ValidatedConnectorRegistry<Configs> = {
  readonly [Type in keyof Configs]: ValidatedConnectorConfig<Configs[Type]>;
};

type AssertValidConnectorRegistry<
  Registry extends Record<string, ConnectorConfig> &
    ValidatedConnectorRegistry<Registry>,
> = Registry;

export type ConnectorRegistryValidation = AssertValidConnectorRegistry<
  typeof CONNECTOR_TYPES
>;
