import {
  InMemoryCredentialStore,
  registerSessionResourceCleanup,
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
import { piAgentRegisteredStream, resolvePiAgentModel } from "./model";
import { piPreheatedResourceLoaderOptions } from "./resources";
import type { PiAgentModelConfig, PiAgentServiceTier } from "./types";

function initializePiSessionResourceRegistry(): void {
  // Vite's SSR bundle otherwise keeps Pi's registry behind only the lazy
  // Codex adapter initializer, while AgentSession.dispose() remains eager.
  // Registering and immediately removing a no-op makes the shared registry's
  // initialization explicit without changing its cleanup policy.
  const unregister = registerSessionResourceCleanup(() => {
    return undefined;
  });
  unregister();
}

function requestScopedPiAgentStream(
  serviceTier: PiAgentServiceTier | undefined,
): typeof piAgentRegisteredStream {
  if (serviceTier === undefined) {
    return piAgentRegisteredStream;
  }
  return (model, context, options) => {
    return piAgentRegisteredStream(model, context, {
      ...options,
      serviceTier,
    });
  };
}

function registeredModelConfig(
  model: NonNullable<ReturnType<typeof resolvePiAgentModel>>,
  apiKey: string,
  serviceTier: PiAgentServiceTier | undefined,
) {
  return {
    name: model.provider,
    baseUrl: model.baseUrl,
    apiKey,
    api: model.api,
    streamSimple: requestScopedPiAgentStream(serviceTier),
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
  initializePiSessionResourceRegistry();
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
    registeredModelConfig(model, args.model.apiKey, args.model.serviceTier),
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
