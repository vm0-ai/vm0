import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  type ModelProviderCodexRuntimeConfig,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  getModelProviderTypeForSurfaceProtocol,
  type ModelProviderSurfaceProtocol,
} from "@vm0/api-contracts/contracts/zero-model-provider-gateways";
import type { ExpandedFirewallConfig } from "@vm0/connectors/firewall-types";

export const GATEWAY_RUNTIME_SECRET_NAME = "VM0_MODEL_PROVIDER_API_KEY";

interface CompileModelProviderGatewayRuntimeArgs {
  readonly surfaceId: string;
  readonly protocol: ModelProviderSurfaceProtocol;
  readonly apiBaseUrl: string;
  readonly displayName: string;
  readonly authHeaderName: string;
  readonly authHeaderTemplate: string;
  readonly upstreamModel: string;
}

interface CompiledModelProviderGatewayRuntime {
  readonly type: ModelProviderType;
  readonly environment: Record<string, string>;
  readonly firewall: ExpandedFirewallConfig;
  readonly codexRuntimeConfig?: ModelProviderCodexRuntimeConfig;
}

export function compileModelProviderGatewayRuntime(
  args: CompileModelProviderGatewayRuntimeArgs,
): CompiledModelProviderGatewayRuntime {
  const type = getModelProviderTypeForSurfaceProtocol(args.protocol);
  const placeholder =
    args.protocol === "anthropic-messages"
      ? MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN
      : MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY;
  const secretRef = `\${{ secrets.${GATEWAY_RUNTIME_SECRET_NAME} }}`;
  const firewall: ExpandedFirewallConfig = {
    name: `model-provider-surface:${args.surfaceId}`,
    description: args.displayName,
    apis: [
      {
        base:
          args.protocol === "anthropic-messages"
            ? `${args.apiBaseUrl}/v1/messages`
            : `${args.apiBaseUrl}/responses`,
        hostPolicy: { kind: "publicDestination" },
        auth: {
          headers: {
            [args.authHeaderName]: args.authHeaderTemplate.replace(
              "{{secret}}",
              secretRef,
            ),
          },
        },
        permissions: [],
      },
    ],
    placeholders: { [GATEWAY_RUNTIME_SECRET_NAME]: placeholder },
  };

  if (args.protocol === "anthropic-messages") {
    return {
      type,
      firewall,
      environment: {
        ANTHROPIC_AUTH_TOKEN: placeholder,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: args.apiBaseUrl,
        ANTHROPIC_MODEL: args.upstreamModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: args.upstreamModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: args.upstreamModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: args.upstreamModel,
        CLAUDE_CODE_SUBAGENT_MODEL: args.upstreamModel,
      },
    };
  }

  return {
    type,
    firewall,
    environment: {
      OPENAI_API_KEY: placeholder,
      OPENAI_BASE_URL: args.apiBaseUrl,
      OPENAI_MODEL: args.upstreamModel,
    },
    codexRuntimeConfig: {
      providerId: `gateway_${args.surfaceId.replaceAll("-", "")}`,
      name: args.displayName,
      baseUrl: args.apiBaseUrl,
      envKey: "OPENAI_API_KEY",
      httpHeaders: { [args.authHeaderName]: placeholder },
      requiresOpenaiAuth: false,
      wireApi: "responses",
      supportsWebsockets: false,
    },
  };
}
