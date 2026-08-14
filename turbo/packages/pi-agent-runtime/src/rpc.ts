import { dirname } from "node:path";

import type { AgentMessage, ExecutionEnv } from "@earendil-works/pi-agent-core";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ModelRuntime,
  runRpcMode,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type Skill as CodingAgentSkill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PiLaunchConfig } from "@okouai/api-contracts/contracts/runners";
import { SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";

import { piAgentStream, resolvePiAgentModel } from "./agent-loop";
import { preparePiLaunchResources } from "./runtime";
import {
  canonicalDurableMessage,
  checkpointingSqliteFactory,
  isPersistedMessage,
} from "./session";
import { createPiExecutionTools, isPiToolTimeoutResult } from "./tools";
import type { PiAgentModelConfig } from "./types";

function codingAgentSkills(
  skills: Awaited<ReturnType<typeof preparePiLaunchResources>>["skills"],
): CodingAgentSkill[] {
  return skills.map((skill) => {
    const baseDir = dirname(skill.filePath);
    return {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(skill.filePath, {
        source: "vm0-launch-snapshot",
        baseDir,
      }),
      disableModelInvocation: skill.disableModelInvocation ?? false,
    };
  });
}

function codingAgentTools(env: ExecutionEnv): ToolDefinition[] {
  return createPiExecutionTools(env).map((tool) => {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute(toolCallId, params, signal, onUpdate) {
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    };
  });
}

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

/** Run the official Pi AgentSession RPC host until stdin closes. */
export async function runPiOfficialRpcMode(args: {
  readonly sessionId: string;
  readonly databasePath: string;
  readonly model: PiAgentModelConfig;
  readonly launchConfig: PiLaunchConfig;
  readonly appendSystemPrompt: string | null;
  readonly executionEnv: ExecutionEnv;
}): Promise<never> {
  const repository = new SqliteSessionRepository({
    env: args.executionEnv,
    sqlite: checkpointingSqliteFactory(),
    databasePath: args.databasePath,
  });
  let closed = false;
  const closeRuntime = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await repository.close();
    } finally {
      await args.executionEnv.cleanup();
    }
  };

  try {
    const metadata = (await repository.list()).find((candidate) => {
      return candidate.id === args.sessionId;
    });
    const sqliteSession = metadata
      ? await repository.open(metadata)
      : await repository.create({
          id: args.sessionId,
          cwd: args.executionEnv.cwd,
        });
    const entries = await sqliteSession.findEntriesOnBranch({
      type: "message",
      order: "oldestFirst",
    });
    const sessionManager = SessionManager.inMemory(args.executionEnv.cwd, {
      id: args.sessionId,
    });
    for (const entry of entries) {
      if (entry.type !== "message" || !isPersistedMessage(entry.message)) {
        throw new Error("Pi session returned a non-message entry");
      }
      sessionManager.appendMessage(canonicalDurableMessage(entry.message));
    }

    const resources = await preparePiLaunchResources(args.executionEnv, {
      launchConfig: args.launchConfig,
      appendSystemPrompt: args.appendSystemPrompt,
    });
    if (resources.diagnostics.length > 0) {
      process.stderr.write(
        `Pi run Skill catalog contains diagnostics: ${JSON.stringify(resources.diagnostics)}\n`,
      );
    }

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
    });
    modelRuntime.registerProvider(
      args.model.provider,
      registeredModelConfig(model, args.model.apiKey),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: args.executionEnv.cwd,
      agentDir: args.executionEnv.cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: resources.systemPrompt,
      skillsOverride() {
        return {
          skills: codingAgentSkills(resources.skills),
          diagnostics: [],
        };
      },
      extensionFactories: [
        {
          name: "vm0-runtime",
          hidden: true,
          factory(pi) {
            pi.on("message_end", async (event) => {
              const message: AgentMessage = event.message;
              if (isPersistedMessage(message)) {
                await sqliteSession.appendMessage(
                  canonicalDurableMessage(message),
                );
              }
            });
            pi.on("tool_result", (event) => {
              return isPiToolTimeoutResult({ details: event.details })
                ? { isError: true }
                : undefined;
            });
            pi.on("session_shutdown", closeRuntime);
          },
        },
      ],
    });
    await resourceLoader.reload();
    const services: AgentSessionServices = {
      cwd: args.executionEnv.cwd,
      agentDir: args.executionEnv.cwd,
      modelRuntime,
      settingsManager,
      resourceLoader,
      diagnostics: [],
    };
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      noTools: "builtin",
      customTools: codingAgentTools(args.executionEnv),
    });
    const unsupportedSessionReplacement: CreateAgentSessionRuntimeFactory =
      async () => {
        throw new Error("Pi sandbox RPC session replacement is unsupported");
      };
    const runtime = new AgentSessionRuntime(
      created.session,
      services,
      unsupportedSessionReplacement,
      [],
      created.modelFallbackMessage,
    );
    return await runRpcMode(runtime);
  } catch (error) {
    await closeRuntime();
    throw error;
  }
}
