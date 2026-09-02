import type {
  PiLaunchConfig,
  PiModelConfig,
  StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";

export interface PiApiFirstTurnActivation {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly executionContext: Pick<
    StoredExecutionContext,
    | "encryptedSecrets"
    | "environment"
    | "modelUsageProvider"
    | "resumeSession"
    | "secretConnectorMap"
    | "secretConnectorMetadataMap"
    | "storageMounts"
  > & {
    readonly apiStartTime: number;
    readonly billableFirewalls: readonly string[];
    readonly piLaunchConfig: PiLaunchConfig;
    readonly piModelConfig: PiModelConfig;
    readonly piSessionId: string;
  };
}

export const PI_API_FIRST_TURN_TIMEOUT_MS = 45_000;
export const PI_API_FIRST_TURN_URL_TTL_SECONDS = 6 * 60 * 60;

export function requirePiApiFirstTurnExecutionContext(
  context: Pick<
    StoredExecutionContext,
    | "apiStartTime"
    | "billableFirewalls"
    | "encryptedSecrets"
    | "environment"
    | "modelUsageProvider"
    | "piLaunchConfig"
    | "piModelConfig"
    | "piSessionId"
    | "resumeSession"
    | "secretConnectorMap"
    | "secretConnectorMetadataMap"
    | "storageMounts"
  >,
): PiApiFirstTurnActivation["executionContext"] {
  if (
    context.apiStartTime === undefined ||
    context.piLaunchConfig === undefined ||
    context.piModelConfig === undefined ||
    context.piSessionId === undefined
  ) {
    throw new Error("Pi API first-turn execution context is incomplete");
  }
  return {
    apiStartTime: context.apiStartTime,
    billableFirewalls: context.billableFirewalls ?? [],
    encryptedSecrets: context.encryptedSecrets,
    environment: context.environment,
    modelUsageProvider: context.modelUsageProvider,
    piLaunchConfig: context.piLaunchConfig,
    piModelConfig: context.piModelConfig,
    piSessionId: context.piSessionId,
    resumeSession: context.resumeSession,
    secretConnectorMap: context.secretConnectorMap,
    secretConnectorMetadataMap: context.secretConnectorMetadataMap,
    storageMounts: context.storageMounts,
  };
}

export function piApiFirstTurnObjectKey(
  runId: string,
  object: "manifest" | "session",
): string {
  return `pi-api-first-turn/${runId}/${object}.json${
    object === "session" ? "l" : ""
  }`;
}

export function refreshPiApiFirstTurnDeadline<
  T extends {
    readonly apiStartTime?: number;
    readonly piLaunchConfig?: PiLaunchConfig;
  },
>(context: T, apiStartTime: number): T {
  const launchConfig = context.piLaunchConfig;
  if (!launchConfig) {
    return { ...context, apiStartTime } as T;
  }
  const slot = launchConfig.apiFirstTurn;
  return {
    ...context,
    apiStartTime,
    piLaunchConfig: {
      ...launchConfig,
      apiFirstTurn: {
        ...slot,
        deadlineAt: apiStartTime + PI_API_FIRST_TURN_TIMEOUT_MS,
      },
    },
  } as T;
}
