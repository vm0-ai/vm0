export interface PiModelConfigObservation {
  readonly piModelConfigGeneration: 1 | 2 | 3 | 4 | "unknown";
  readonly piModelConfigLegacyApi:
    | "absent"
    | "public-responses"
    | "historical-completions"
    | "historical-codex"
    | "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyApiState(
  config: Record<string, unknown>,
): PiModelConfigObservation["piModelConfigLegacyApi"] {
  if (!Object.hasOwn(config, "api")) {
    return "absent";
  }
  switch (config.api) {
    case "openai-responses": {
      return "public-responses";
    }
    case "openai-completions": {
      return "historical-completions";
    }
    case "openai-codex-responses": {
      return "historical-codex";
    }
    default: {
      return "unknown";
    }
  }
}

/** Only bounded metadata may cross this boundary, never captured config values. */
export function piModelConfigObservation(
  cliAgentType: string | undefined,
  config: unknown,
): PiModelConfigObservation | undefined {
  if (cliAgentType !== "pi") {
    return undefined;
  }
  if (!isRecord(config)) {
    return {
      piModelConfigGeneration: "unknown",
      piModelConfigLegacyApi: "unknown",
    };
  }
  const generation = !("schemaVersion" in config)
    ? 1
    : config.schemaVersion === 2 ||
        config.schemaVersion === 3 ||
        config.schemaVersion === 4
      ? config.schemaVersion
      : "unknown";
  return {
    piModelConfigGeneration: generation,
    piModelConfigLegacyApi: legacyApiState(config),
  };
}
