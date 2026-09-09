import type {
  ExpandedFirewallConfig,
  ExecutionFirewalls,
} from "@okouai/connectors/firewall-types";
import {
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
  piModelConfigV4Schema,
  piNativeInferenceUrl,
  type PiModelConfigV4,
} from "./pi-native";

/** Compile a stored native route for the existing Runner egress auth consumer. */
export function piNativeFirewall(
  input: PiModelConfigV4,
): ExpandedFirewallConfig {
  const config = piModelConfigV4Schema.parse(input);
  const placeholders = Object.fromEntries(
    config.credentialBindings.map((binding) => {
      return [binding.secretName, PI_NATIVE_CREDENTIAL_PLACEHOLDER];
    }),
  );
  const secret = (kind: string): string => {
    const binding = config.credentialBindings.find((value) => {
      return value.kind === kind;
    });
    if (!binding)
      throw new Error("Pi native firewall credential binding is missing");
    return `\${{ secrets.${binding.secretName} }}`;
  };
  const api = {
    base: piNativeInferenceUrl(config),
    hostPolicy: { kind: "publicDestination" as const },
    permissions: [],
  };
  const name = `model-provider:${config.route}`;
  if (config.dialect === "anthropic-messages") {
    const binding = config.credentialBindings[0];
    if (!binding)
      throw new Error("Pi native firewall API-key binding is missing");
    return {
      name,
      placeholders,
      apis: [
        {
          ...api,
          auth: {
            headers: {
              [binding.credentialHeader.name]:
                binding.credentialHeader.valueTemplate.replace(
                  "{{secret}}",
                  secret("api-key"),
                ),
            },
          },
        },
      ],
    };
  }
  return {
    name,
    placeholders,
    apis: [
      {
        ...api,
        auth:
          config.authMode === "bearer"
            ? {
                headers: {
                  Authorization: `Bearer ${secret("aws-bearer-token")}`,
                },
              }
            : {
                awsSigv4: {
                  accessKeyId: secret("aws-access-key-id"),
                  secretAccessKey: secret("aws-secret-access-key"),
                  ...(config.credentialBindings.some((binding) => {
                    return binding.kind === "aws-session-token";
                  })
                    ? { sessionToken: secret("aws-session-token") }
                    : {}),
                },
              },
      },
    ],
  };
}

/** A persisted native context must carry exactly the route's egress authority. */
export function piNativeContextHasExactEgress(
  config: PiModelConfigV4,
  context: {
    readonly environment?: Readonly<Record<string, string>> | null;
    readonly firewalls?: ExecutionFirewalls;
  },
): boolean {
  if (
    config.credentialBindings.some((binding) => {
      return (
        context.environment?.[binding.environment] !==
        PI_NATIVE_CREDENTIAL_PLACEHOLDER
      );
    })
  )
    return false;
  const expected = piNativeFirewall(config);
  const native = context.firewalls?.filter((entry) => {
    return entry.kind === "inline" && entry.firewall.name === expected.name;
  });
  if (native?.length !== 1 || native[0]?.kind !== "inline") return false;
  const apis = native[0].firewall.apis;
  const actual = apis[0];
  const required = expected.apis[0];
  if (
    apis.length !== 1 ||
    !actual ||
    !required ||
    actual.base !== required.base ||
    actual.hostPolicy?.kind !== "publicDestination" ||
    actual.auth.base !== undefined ||
    actual.auth.query !== undefined ||
    (actual.permissions?.length ?? 0) !== 0
  )
    return false;
  const normalize = (headers: Readonly<Record<string, string>> | undefined) => {
    return Object.entries(headers ?? {})
      .map(([name, value]) => {
        return [name.toLowerCase(), value] as const;
      })
      .sort(([a], [b]) => {
        return a.localeCompare(b);
      });
  };
  return (
    JSON.stringify(normalize(actual.auth.headers)) ===
      JSON.stringify(normalize(required.auth.headers)) &&
    JSON.stringify(normalize(actual.auth.awsSigv4)) ===
      JSON.stringify(normalize(required.auth.awsSigv4))
  );
}
