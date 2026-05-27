import chalk from "chalk";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
  type ConnectorConfig,
  type ConnectorGenerationType,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { getConnectorGenerationTypes } from "@vm0/connectors/connector-utils";
import type { ConnectorListResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { getZeroAgentUserConnectors } from "../../../../lib/api/domains/zero-agents";
import {
  listZeroConnectors,
  searchZeroConnectors,
} from "../../../../lib/api/domains/zero-connectors";
import { getPlatformOrigin } from "../../doctor/platform-url";

type BuiltInGenerationType =
  | "dashboard-design"
  | "docs-design"
  | "image"
  | "mobile-app-design"
  | "poster"
  | "presentation"
  | "report"
  | "video"
  | "voice"
  | "website";
export type GenerationType = ConnectorGenerationType | BuiltInGenerationType;

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

interface GenerationContext {
  readonly lines: readonly string[];
}

const BUILT_IN_GENERATION_PROVIDERS: Partial<
  Record<GenerationType, readonly BuiltInGenerationProvider[]>
> = {
  image: [
    {
      label: "Built-in fal.ai",
      model: "gpt-image-1",
      command: "zero generate image --provider built-in --model gpt-image-1 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "gpt-image-2",
      command: "zero generate image --provider built-in --model gpt-image-2 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "gpt-image-1.5",
      command:
        "zero generate image --provider built-in --model gpt-image-1.5 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "gpt-image-1-mini",
      command:
        "zero generate image --provider built-in --model gpt-image-1-mini -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/flux-pro/v1.1",
      command:
        "zero generate image --provider built-in --model flux-pro-1.1 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/flux-pro/v1.1-ultra",
      command:
        "zero generate image --provider built-in --model flux-pro-1.1-ultra -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/qwen-image",
      command: "zero generate image --provider built-in --model qwen-image -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/bytedance/seedream/v4/text-to-image",
      command: "zero generate image --provider built-in --model seedream4 -h",
      reason: "available without connector setup",
    },
  ],
  presentation: [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero generate presentation --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
  report: [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero generate report --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
  "docs-design": [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero generate docs-design --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
  poster: [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero generate poster --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
  "dashboard-design": [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero generate dashboard-design --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
  "mobile-app-design": [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero generate mobile-app-design --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
  website: [
    {
      label: "Built-in",
      model: "gpt-5.5",
      command: "zero generate website --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
  video: [
    {
      label: "Built-in",
      model: "dreamina-seedance-2-0-260128",
      command:
        "zero generate video --provider built-in --model dreamina-seedance-2.0 -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in",
      model: "dreamina-seedance-2-0-fast-260128",
      command:
        "zero generate video --provider built-in --model dreamina-seedance-2.0-fast -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in",
      model: "seedance-1-5-pro-251215",
      command:
        "zero generate video --provider built-in --model seedance-1.5-pro -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/veo3.1/fast",
      command: "zero generate video --provider built-in --model veo3.1-fast -h",
      reason: "available without connector setup",
    },
    {
      label: "Built-in fal.ai",
      model: "fal-ai/kling-video/v3/4k/text-to-video",
      command: "zero generate video --provider built-in --model kling-v3-4k -h",
      reason: "available without connector setup",
    },
  ],
  voice: [
    {
      label: "Built-in",
      model: "gpt-4o-mini-tts",
      command: "zero generate voice --provider built-in -h",
      reason: "available without connector setup",
    },
  ],
};

const BUILT_IN_GENERATION_COMMANDS: Partial<
  Record<GenerationType, BuiltInGenerationCommand>
> = {
  image: {
    label: "Built-in image generation",
    command: "zero generate image --provider built-in -h",
    models:
      "fal.ai: gpt-image-1 (default), gpt-image-2, gpt-image-1.5, gpt-image-1-mini, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, seedream4",
  },
  video: {
    label: "Built-in video generation",
    command: "zero generate video --provider built-in -h",
    models:
      "dreamina-seedance-2.0-fast (default), dreamina-seedance-2.0, seedance-1.5-pro, veo3.1-fast, kling-v3-4k",
  },
  presentation: {
    label: "Built-in presentation generation",
    command: "zero generate presentation --provider built-in -h",
    models: "gpt-5.5",
  },
  report: {
    label: "Built-in report generation",
    command: "zero generate report --provider built-in -h",
    models: "gpt-5.5",
  },
  "docs-design": {
    label: "Built-in docs design generation",
    command: "zero generate docs-design --provider built-in -h",
    models: "gpt-5.5",
  },
  poster: {
    label: "Built-in poster generation",
    command: "zero generate poster --provider built-in -h",
    models: "gpt-5.5",
  },
  "dashboard-design": {
    label: "Built-in dashboard design generation",
    command: "zero generate dashboard-design --provider built-in -h",
    models: "gpt-5.5",
  },
  "mobile-app-design": {
    label: "Built-in mobile app design generation",
    command: "zero generate mobile-app-design --provider built-in -h",
    models: "gpt-5.5",
  },
  website: {
    label: "Built-in website generation",
    command: "zero generate website --provider built-in -h",
    models: "gpt-5.5",
  },
  voice: {
    label: "Built-in voice generation",
    command: "zero generate voice --provider built-in -h",
    models: "gpt-4o-mini-tts",
  },
};

const GENERATION_CONTEXT: Partial<Record<GenerationType, GenerationContext>> = {
  website: {
    lines: [
      "Standalone static website artifacts can be authored locally and published with zero host for a public URL.",
      "zero host is for static directories with index.html; it is not a general deploy system for apps that need a backend, database, worker, or long-running process.",
      "Existing web app changes should usually follow the project's own build, test, and deploy workflow.",
    ],
  },
};

const GENERATION_TYPE_ORDER: readonly GenerationType[] = [
  "image",
  "video",
  "audio",
  "voice",
  "text",
  "code",
  "document",
  "presentation",
  "website",
  "report",
  "docs-design",
  "poster",
  "dashboard-design",
  "mobile-app-design",
];

const GENERATION_TYPE_LABELS: Record<GenerationType, string> = {
  audio: "Audio",
  code: "Code",
  "dashboard-design": "Dashboard design",
  document: "Document",
  "docs-design": "Docs design",
  image: "Image",
  "mobile-app-design": "Mobile app design",
  poster: "Poster",
  presentation: "Presentation",
  report: "Report",
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

interface ListerOptions {
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
  generationType: GenerationType,
): ConnectorGenerationType | null {
  switch (generationType) {
    case "voice":
      return "audio";
    case "dashboard-design":
    case "docs-design":
    case "mobile-app-design":
    case "poster":
    case "report":
      return null;
    case "audio":
    case "code":
    case "document":
    case "image":
    case "presentation":
    case "text":
    case "video":
    case "website":
      return generationType;
  }
}

function getBuiltInProviders(
  generationType: GenerationType,
): readonly BuiltInGenerationProvider[] {
  return BUILT_IN_GENERATION_PROVIDERS[generationType] ?? [];
}

function getBuiltInCommand(
  generationType: GenerationType,
): BuiltInGenerationCommand | null {
  return BUILT_IN_GENERATION_COMMANDS[generationType] ?? null;
}

function getGenerationContext(
  generationType: GenerationType,
): GenerationContext | null {
  return GENERATION_CONTEXT[generationType] ?? null;
}

function getAvailableGenerationTypes(): GenerationType[] {
  const available = new Set<ConnectorGenerationType>();
  for (const type of CONNECTOR_TYPE_KEYS) {
    for (const generationType of getConnectorGenerationTypes(type)) {
      available.add(generationType);
    }
  }

  return GENERATION_TYPE_ORDER.filter((type) => {
    const connectorGenerationType = getConnectorGenerationType(type);
    return (
      getBuiltInProviders(type).length > 0 ||
      (connectorGenerationType !== null &&
        available.has(connectorGenerationType))
    );
  });
}

function getGenerationConnectors(
  generationType: ConnectorGenerationType,
): Array<[ConnectorType, ConnectorConfig]> {
  return CONNECTOR_TYPE_KEYS.map((type): [ConnectorType, ConnectorConfig] => {
    return [type, CONNECTOR_TYPES[type]];
  })
    .filter(([type]) => {
      return getConnectorGenerationTypes(type).includes(generationType);
    })
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    });
}

function isConnectorType(type: string): type is ConnectorType {
  return type in CONNECTOR_TYPES;
}

async function getFeatureAvailableConnectorTypes(): Promise<
  Set<ConnectorType>
> {
  const catalog = await searchZeroConnectors();
  return new Set(
    catalog.connectors
      .map((connector) => {
        return connector.id;
      })
      .filter(isConnectorType),
  );
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
  availableTypes: Set<ConnectorType>;
  authorizedTypes: Set<string> | null;
  agentId: string | undefined;
  platformOrigin: string;
}): GenerationCandidate {
  const {
    type,
    config,
    connector,
    configuredTypes,
    availableTypes,
    authorizedTypes,
    agentId,
    platformOrigin,
  } = params;

  let status: CandidateStatus;
  let reason: string;

  if (!availableTypes.has(type)) {
    status = "not-available";
    reason = "not available for this account";
  } else if (connector?.needsReconnect) {
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

function renderBuiltInProvider(generationType: GenerationType): void {
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

function renderGenerationContext(generationType: GenerationType): void {
  const context = getGenerationContext(generationType);
  if (!context) return;

  console.log("");
  console.log("Context:");
  for (const line of context.lines) {
    console.log(`  - ${line}`);
  }
}

function renderText(params: {
  generationType: GenerationType;
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
  renderGenerationContext(generationType);

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

export async function runLister(
  generationType: GenerationType,
  options: ListerOptions = {},
): Promise<void> {
  const connectorGenerationType = getConnectorGenerationType(generationType);
  const agentId = process.env.ZERO_AGENT_ID;
  const [connectorList, availableTypes, enabledTypes, platformOrigin] =
    await Promise.all([
      listZeroConnectors(),
      getFeatureAvailableConnectorTypes(),
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
  const candidates = connectorGenerationType
    ? getGenerationConnectors(connectorGenerationType).map(
        ([connectorType, config]) => {
          return toCandidate({
            type: connectorType,
            config,
            connector: connectedMap.get(connectorType),
            configuredTypes,
            availableTypes,
            authorizedTypes,
            agentId,
            platformOrigin,
          });
        },
      )
    : [];
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
          builtInCommand: getBuiltInCommand(generationType),
          generationContext: getGenerationContext(generationType),
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
}
