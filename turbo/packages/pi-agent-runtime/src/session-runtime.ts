import {
  InMemoryCredentialStore,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashTool,
  ModelRuntime,
  SettingsManager,
  type CreateAgentSessionFromServicesOptions,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { PiPreheatedResourceSnapshot } from "./api-types";
import { piAgentStream, resolvePiAgentModel } from "./model";
import { piPreheatedResourceLoaderOptions } from "./resources";
import type { PiAgentModelConfig } from "./types";

function registeredModelConfig(
  model: NonNullable<ReturnType<typeof resolvePiAgentModel>>,
  apiKey: string,
) {
  return {
    name: model.provider,
    baseUrl: model.baseUrl,
    apiKey,
    api: model.api,
    streamSimple: piAgentStream,
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        samplingParams: model.samplingParams,
        headers: model.headers,
        compat: model.compat,
      },
    ],
  };
}

function configuredThinkingLevel(
  sessionManager: SessionManager,
  configured: ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  const hasThinkingEntry = sessionManager.getBranch().some((entry) => {
    return entry.type === "thinking_level_change";
  });
  if (!hasThinkingEntry) {
    return configured;
  }
  const existing = sessionManager.buildSessionContext().thinkingLevel;
  switch (existing) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max": {
      return existing;
    }
    default: {
      throw new Error(`Unsupported Pi session thinking level: ${existing}`);
    }
  }
}

export async function createPiAgentSessionForRuntime(args: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionManager: SessionManager;
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
  readonly resourceSnapshot?: PiPreheatedResourceSnapshot;
  readonly sessionStartEvent?: CreateAgentSessionFromServicesOptions["sessionStartEvent"];
}) {
  const model = resolvePiAgentModel(args.model);
  if (!model) {
    throw new Error(
      `Pi provider ${args.model.provider} does not catalog model ${args.model.model}`,
    );
  }

  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
    ...(args.resourceSnapshot
      ? { credentials: new InMemoryCredentialStore() }
      : {}),
  });
  modelRuntime.registerProvider(
    args.model.provider,
    registeredModelConfig(model, args.model.apiKey),
  );
  const services = await createAgentSessionServices({
    cwd: args.cwd,
    agentDir: args.agentDir,
    modelRuntime,
    ...(args.resourceSnapshot
      ? {
          settingsManager: SettingsManager.inMemory(
            {},
            { projectTrusted: true },
          ),
        }
      : {}),
    resourceLoaderOptions: args.resourceSnapshot
      ? piPreheatedResourceLoaderOptions({
          snapshot: args.resourceSnapshot,
          appendSystemPrompt: args.appendSystemPrompt,
        })
      : args.appendSystemPrompt === null
        ? undefined
        : { appendSystemPrompt: [args.appendSystemPrompt] },
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: args.sessionManager,
    sessionStartEvent: args.sessionStartEvent,
    model,
    thinkingLevel: configuredThinkingLevel(
      args.sessionManager,
      args.model.thinkingLevel,
    ),
    customTools: [
      createBashTool(args.cwd, {
        shellPath: "/usr/local/bin/guest-tool-exec",
      }),
    ],
  });
  return { ...created, services, model };
}
