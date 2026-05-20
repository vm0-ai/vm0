import { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTOR_TYPES,
  type ConnectorConfig,
  type ConnectorGenerationType,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import type { ConnectorListResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { getZeroAgentUserConnectors } from "../../../lib/api/domains/zero-agents";
import { listZeroConnectors } from "../../../lib/api/domains/zero-connectors";
import { withErrorHandler } from "../../../lib/command";
import { getPlatformOrigin } from "./platform-url";

type BuiltInGenerationType =
  | "image"
  | "presentation"
  | "video"
  | "voice"
  | "website";
type DoctorGenerationType = ConnectorGenerationType | BuiltInGenerationType;

interface BuiltInGenerationProvider {
  label: string;
  model: string;
  command: string;
  reason: string;
}

interface BuiltInGenerationCommand {
  label: string;
  command: string;
  models: string;
}

const BUILT_IN_GENERATION_PROVIDERS: Partial<
  Record<DoctorGenerationType, readonly BuiltInGenerationProvider[]>
> = {
  image: [
    {
      label: "Built-in fal.ai",
      model: "gpt-image-1",
      command: "zero built-in generate image --model gpt-image-1 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "gpt-image-2",
      command: "zero built-in generate image --model gpt-image-2 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "gpt-image-1.5",
      command: "zero built-in generate image --model gpt-image-1.5 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "gpt-image-1-mini",
      command: "zero built-in generate image --model gpt-image-1-mini -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/flux-pro/v1.1",
      command: "zero built-in generate image --model flux-pro-1.1 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/flux-pro/v1.1-ultra",
      command: "zero built-in generate image --model flux-pro-1.1-ultra -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/qwen-image",
      command: "zero built-in generate image --model qwen-image -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/bytedance/seedream/v4/text-to-image",
      command: "zero built-in generate image --model seedream4 -h",
      reason: "available without connector setup",
    },
  ],
  presentation: [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero built-in generate presentation -h",
      reason: "available without connector setup",
    },
  ],
  website: [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero built-in generate website -h",
      reason: "available without connector setup",
    },
  ],
  video: [
    {
      label: "Built-in",
      model: "fal-ai/veo3.1/fast",
      command: "zero built-in generate video --model veo3.1-fast -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in",
      model: "fal-ai/veo3.1",
      command: "zero built-in generate video --model veo3.1 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in",
      model: "fal-ai/kling-video/o3/standard/text-to-video",
      command: "zero built-in generate video --model kling-o3-standard -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in",
      model: "fal-ai/kling-video/v3/4k/text-to-video",
      command: "zero built-in generate video --model kling-v3-4k -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in",
      model: "bytedance/seedance-2.0/text-to-video",
      command: "zero built-in generate video --model seedance2.0 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in",
      model: "bytedance/seedance-2.0/fast/text-to-video",
      command: "zero built-in generate video --model seedance2.0-fast -h",
      reason: "available without connector setup",
    },
  ],
  voice: [
    {
      label: "Built-in",
      model: "gpt-4o-mini-tts",
      command: "zero built-in generate voice -h",
      reason: "available without connector setup",
    },
  ],
};

const BUILT_IN_GENERATION_COMMANDS: Partial<
  Record<DoctorGenerationType, BuiltInGenerationCommand>
> = {
  image: {
    label: "Built-in image generation",
    command: "zero built-in generate image -h",
    models:
      "fal.ai: gpt-image-1 (default), gpt-image-2, gpt-image-1.5, gpt-image-1-mini, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, seedream4",
  },
  video: {
    label: "Built-in video generation",
    command: "zero built-in generate video -h",
    models:
      "veo3.1-fast, veo3.1, kling-o3-standard, kling-v3-4k, seedance2.0, seedance2.0-fast",
  },
  presentation: {
    label: "Built-in presentation generation",
    command: "zero built-in generate presentation -h",
    models: "gpt-5.5",
  },
  website: {
    label: "Built-in website generation",
    command: "zero built-in generate website -h",
    models: "gpt-5.5",
  },
  voice: {
    label: "Built-in voice generation",
    command: "zero built-in generate voice -h",
    models: "gpt-4o-mini-tts",
  },
};

const GENERATION_TYPE_ORDER: readonly DoctorGenerationType[] = [
  "image",
  "video",
  "audio",
  "voice",
  "text",
  "code",
  "document",
  "presentation",
  "website",
];

const GENERATION_TYPE_LABELS: Record<DoctorGenerationType, string> = {
  audio: "Audio",
  code: "Code",
  document: "Document",
  image: "Image",
  presentation: "Presentation",
  text: "Text",
  video: "Video",
  voice: "Voice",
  website: "Website",
};

type ConnectedConnector = ConnectorListResponse["connectors"][number];

type CandidateStatus =
  | "ready"
  | "needs-reconnect"
  | "not-authorized"
  | "not-connected"
  | "not-available";

interface GenerateOptions {
  all?: boolean;
  json?: boolean;
}

interface GenerationCandidate {
  type: ConnectorType;
  label: string;
  status: CandidateStatus;
  reason: string;
  account?: string;
  authMethod?: string;
  actionLabel?: string;
  actionUrl?: string;
}

function getConnectorGenerationType(
  generationType: DoctorGenerationType,
): ConnectorGenerationType {
  if (generationType === "voice") {
    return "audio";
  }

  return generationType;
}

function getBuiltInProviders(
  generationType: DoctorGenerationType,
): readonly BuiltInGenerationProvider[] {
  return BUILT_IN_GENERATION_PROVIDERS[generationType] ?? [];
}

function getBuiltInCommand(
  generationType: DoctorGenerationType,
): BuiltInGenerationCommand | null {
  return BUILT_IN_GENERATION_COMMANDS[generationType] ?? null;
}

function getAvailableGenerationTypes(): DoctorGenerationType[] {
  const available = new Set<ConnectorGenerationType>();
  for (const config of Object.values(CONNECTOR_TYPES)) {
    for (const generationType of config.generation ?? []) {
      available.add(generationType);
    }
  }

  return GENERATION_TYPE_ORDER.filter((type) => {
    return (
      getBuiltInProviders(type).length > 0 ||
      available.has(getConnectorGenerationType(type))
    );
  });
}

function parseGenerationType(value: string): DoctorGenerationType {
  const availableTypes = getAvailableGenerationTypes();
  if (availableTypes.includes(value as DoctorGenerationType)) {
    return value as DoctorGenerationType;
  }

  throw new Error(`Unknown generation type: ${value}`, {
    cause: new Error(`Available types: ${availableTypes.join(", ")}`),
  });
}

function getGenerationConnectors(
  generationType: ConnectorGenerationType,
): Array<[ConnectorType, ConnectorConfig]> {
  return (
    Object.entries(CONNECTOR_TYPES) as Array<[ConnectorType, ConnectorConfig]>
  )
    .filter(([, config]) => {
      return config.generation?.includes(generationType) === true;
    })
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    });
}

function formatAccount(connector: ConnectedConnector): string | undefined {
  if (connector.externalUsername) return `@${connector.externalUsername}`;
  if (connector.externalEmail) return connector.externalEmail;
  if (connector.externalId) return connector.externalId;
  return undefined;
}

function getAction(
  status: CandidateStatus,
  type: ConnectorType,
  label: string,
  agentId: string | undefined,
  platformOrigin: string,
): { actionLabel?: string; actionUrl?: string } {
  if (status === "needs-reconnect") {
    return {
      actionLabel: `Reconnect ${label}`,
      actionUrl: `${platformOrigin}/connectors`,
    };
  }

  if (status === "not-authorized" && agentId) {
    return {
      actionLabel: `Authorize ${label}`,
      actionUrl: `${platformOrigin}/connectors/${type}/authorize?agentId=${agentId}`,
    };
  }

  if (status === "not-connected") {
    if (agentId) {
      return {
        actionLabel: `Connect and authorize ${label}`,
        actionUrl: `${platformOrigin}/connectors/${type}/connect?agentId=${agentId}`,
      };
    }

    return {
      actionLabel: `Connect ${label}`,
      actionUrl: `${platformOrigin}/connectors/${type}/connect`,
    };
  }

  return {};
}

function toCandidate(params: {
  type: ConnectorType;
  config: ConnectorConfig;
  connector: ConnectedConnector | undefined;
  configuredTypes: Set<ConnectorType>;
  authorizedTypes: Set<string> | null;
  agentId: string | undefined;
  platformOrigin: string;
}): GenerationCandidate {
  const {
    type,
    config,
    connector,
    configuredTypes,
    authorizedTypes,
    agentId,
    platformOrigin,
  } = params;

  let status: CandidateStatus;
  let reason: string;

  if (connector?.needsReconnect) {
    status = "needs-reconnect";
    reason = "connected, reconnect required";
  } else if (!connector) {
    status = configuredTypes.has(type) ? "not-connected" : "not-available";
    reason =
      status === "not-connected"
        ? agentId
          ? "not connected or authorized for current agent"
          : "not connected"
        : "not available in this environment";
  } else if (authorizedTypes && !authorizedTypes.has(type)) {
    status = "not-authorized";
    reason = "connected, not authorized for current agent";
  } else {
    status = "ready";
    reason = agentId
      ? "connected and authorized for current agent"
      : "connected; agent authorization was not checked";
  }

  return {
    type,
    label: config.label,
    status,
    reason,
    account: connector ? formatAccount(connector) : undefined,
    authMethod: connector?.authMethod,
    ...getAction(status, type, config.label, agentId, platformOrigin),
  };
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function renderRows(candidates: GenerationCandidate[]): void {
  const typeWidth = Math.max(
    4,
    ...candidates.map((candidate) => {
      return candidate.type.length;
    }),
  );
  const labelWidth = Math.max(
    5,
    ...candidates.map((candidate) => {
      return candidate.label.length;
    }),
  );

  for (const candidate of candidates) {
    const suffix =
      candidate.status === "ready"
        ? (candidate.account ?? candidate.authMethod ?? "")
        : candidate.reason;
    console.log(
      `  ${pad(candidate.type, typeWidth)}  ${pad(candidate.label, labelWidth)}  ${suffix}`,
    );
  }
}

function renderActions(candidates: GenerationCandidate[]): void {
  const actionable = candidates.filter((candidate) => {
    return candidate.actionLabel && candidate.actionUrl;
  });
  if (actionable.length === 0) return;

  console.log("");
  console.log("Next actions:");
  for (const candidate of actionable) {
    console.log(`  [${candidate.actionLabel}](${candidate.actionUrl})`);
  }
}

function renderBuiltInProvider(generationType: DoctorGenerationType): void {
  const command = getBuiltInCommand(generationType);
  if (command) {
    console.log("");
    console.log("Built-in command:");
    console.log(`  vm0  ${command.label}`);
    console.log(`  Models: ${command.models}`);
    console.log(`  Use: ${command.command}`);
    return;
  }

  const providers = getBuiltInProviders(generationType);
  if (providers.length === 0) return;

  console.log("");
  console.log(
    providers.length === 1 ? "Built-in provider:" : "Built-in providers:",
  );
  for (const provider of providers) {
    console.log(`  vm0  ${provider.label}  Model: ${provider.model}`);
    console.log(`  Use: ${provider.command}`);
  }
}

function renderText(params: {
  generationType: DoctorGenerationType;
  agentId: string | undefined;
  ready: GenerationCandidate[];
  other: GenerationCandidate[];
  showAll: boolean;
}): void {
  const { generationType, agentId, ready, other, showAll } = params;
  const label = GENERATION_TYPE_LABELS[generationType];
  const scope = agentId ? "for current agent" : "(connected connectors)";

  console.log(`${label} generation choices ${scope}`);
  console.log("");

  if (agentId) {
    console.log(`${"Agent:".padEnd(10)}${agentId}`);
    console.log("");
  } else {
    console.log(
      "ZERO_AGENT_ID is not set, so agent authorization could not be checked.",
    );
    console.log("");
  }

  const hasBuiltInCommand = getBuiltInCommand(generationType) !== null;
  const showConnectorSummary =
    ready.length > 0 || !hasBuiltInCommand || showAll;
  if (showConnectorSummary) {
    console.log("Connectors:");
    if (ready.length > 0) {
      renderRows(ready);
    } else {
      console.log(`  No ready ${generationType} generation connectors found.`);
    }
  }

  renderBuiltInProvider(generationType);

  if (showAll && other.length > 0) {
    console.log("");
    console.log(`Other ${generationType} generation connectors`);
    console.log("");
    renderRows(other);
  }

  if (showAll) {
    renderActions(other);
  }
}

export const generateCommand = new Command()
  .name("generate")
  .description("Show generation connector choices for the current agent")
  .argument(
    "<type>",
    `Generation type (${getAvailableGenerationTypes().join(", ")})`,
  )
  .option("--all", "Also show unavailable or not-yet-authorized connectors")
  .option("--json", "Output machine-readable JSON")
  .action(
    withErrorHandler(async (type: string, options: GenerateOptions) => {
      const generationType = parseGenerationType(type);
      const connectorGenerationType =
        getConnectorGenerationType(generationType);
      const agentId = process.env.ZERO_AGENT_ID;
      const [connectorList, enabledTypes, platformOrigin] = await Promise.all([
        listZeroConnectors(),
        agentId ? getZeroAgentUserConnectors(agentId) : Promise.resolve(null),
        getPlatformOrigin(),
      ]);
      const connectedMap = new Map(
        connectorList.connectors.map((connector) => {
          return [connector.type, connector];
        }),
      );
      const configuredTypes = new Set(connectorList.configuredTypes);
      const authorizedTypes = enabledTypes ? new Set(enabledTypes) : null;
      const candidates = getGenerationConnectors(connectorGenerationType).map(
        ([connectorType, config]) => {
          return toCandidate({
            type: connectorType,
            config,
            connector: connectedMap.get(connectorType),
            configuredTypes,
            authorizedTypes,
            agentId,
            platformOrigin,
          });
        },
      );
      const ready = candidates.filter((candidate) => {
        return candidate.status === "ready";
      });
      const other = candidates.filter((candidate) => {
        return candidate.status !== "ready";
      });
      const builtInProviders = getBuiltInProviders(generationType);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              generationType,
              connectorGenerationType,
              availableTypes: getAvailableGenerationTypes(),
              agentId: agentId ?? null,
              choices: ready,
              otherCandidates: other,
              builtInProvider: builtInProviders[0] ?? null,
              builtInProviders,
            },
            null,
            2,
          ),
        );
        return;
      }

      renderText({
        generationType,
        agentId,
        ready,
        other,
        showAll: options.all === true,
      });

      const shouldShowOtherHint =
        !options.all &&
        other.length > 0 &&
        (ready.length > 0 || getBuiltInCommand(generationType) === null);
      if (shouldShowOtherHint) {
        console.log("");
        console.log(
          chalk.dim(
            `Use --all to see every ${generationType} generation candidate.`,
          ),
        );
      }
    }),
  );
