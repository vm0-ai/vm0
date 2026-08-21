import {
  createBashTool,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  runRpcMode,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import { piAgentStream, resolvePiAgentModel } from "./model";
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
        headers: model.headers,
        compat: model.compat,
      },
    ],
  };
}

async function resolveSessionManager(args: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionId: string;
}): Promise<SessionManager> {
  const existing = (await SessionManager.list(args.cwd, args.sessionDir)).find(
    (candidate) => {
      return candidate.id === args.sessionId;
    },
  );
  return existing
    ? SessionManager.open(existing.path, args.sessionDir, args.cwd)
    : SessionManager.create(args.cwd, args.sessionDir, { id: args.sessionId });
}

function createRuntimeFactory(args: {
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
}): CreateAgentSessionRuntimeFactory {
  const model = resolvePiAgentModel(args.model);
  if (!model) {
    throw new Error(
      `Pi provider ${args.model.provider} does not catalog model ${args.model.model}`,
    );
  }

  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(
      args.model.provider,
      registeredModelConfig(model, args.model.apiKey),
    );
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions:
        args.appendSystemPrompt === null
          ? undefined
          : { appendSystemPrompt: [args.appendSystemPrompt] },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      customTools: [
        createBashTool(cwd, {
          shellPath: "/usr/local/bin/guest-tool-exec",
        }),
      ],
    });
    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };
}

/** Run Pi's official AgentSession RPC host until stdin closes. */
export async function runPiOfficialRpcMode(args: {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly model: PiAgentModelConfig;
  readonly appendSystemPrompt: string | null;
}): Promise<never> {
  const createRuntime = createRuntimeFactory(args);
  const sessionManager = await resolveSessionManager(args);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: args.cwd,
    agentDir: args.agentDir,
    sessionManager,
  });
  return await runRpcMode(runtime);
}
