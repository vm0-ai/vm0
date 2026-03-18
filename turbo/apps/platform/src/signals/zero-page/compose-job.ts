/**
 * Helper for triggering and polling compose jobs from the app UI.
 */
import { delay } from "signal-timers";
import { VALID_CAPABILITIES } from "@vm0/core";

interface ComposeContent {
  agents?: Record<
    string,
    { experimental_capabilities?: string[]; [key: string]: unknown }
  >;
  [key: string]: unknown;
}

/**
 * Ensure the first agent in `content` has `experimental_capabilities`.
 * If already present, the existing value is preserved.
 */
export function injectDefaultCapabilities(content: object): object {
  const c = content as ComposeContent;
  if (!c.agents) {
    return content;
  }

  const agentKey = Object.keys(c.agents)[0];
  if (!agentKey) {
    return content;
  }

  const agent = c.agents[agentKey];
  if (agent.experimental_capabilities) {
    return content;
  }

  return {
    ...c,
    agents: {
      ...c.agents,
      [agentKey]: {
        ...agent,
        experimental_capabilities: [...VALID_CAPABILITIES],
      },
    },
  };
}

interface ComposeJobResponse {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: {
    composeId: string;
    composeName: string;
    versionId: string;
    warnings: string[];
  };
  error?: string;
}

/**
 * Create a compose job and poll until completion.
 * Used by both the config dialog "Build" and instructions "Build" buttons.
 */
export async function triggerAndPollComposeJob(
  fetchFn: typeof fetch,
  content: object,
  instructions?: string,
): Promise<ComposeJobResponse> {
  // Ensure capabilities are present for Zero agents
  const resolvedContent = injectDefaultCapabilities(content);

  // Create compose job
  const createResponse = await fetchFn("/api/compose/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      instructions !== undefined
        ? { content: resolvedContent, instructions }
        : { content: resolvedContent },
    ),
  });

  if (!createResponse.ok) {
    const errorData = (await createResponse.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      errorData?.error?.message ?? `Build failed: ${createResponse.statusText}`,
    );
  }

  const job = (await createResponse.json()) as ComposeJobResponse;

  // If already completed (returned existing job)
  if (job.status === "completed" || job.status === "failed") {
    if (job.status === "failed") {
      throw new Error(job.error ?? "Build failed");
    }
    return job;
  }

  // Poll until done (2s intervals, up to ~5.5 minutes)
  // Must exceed the 5-minute E2B sandbox timeout to allow for sandbox creation,
  // script startup, and webhook delivery overhead.
  const maxAttempts = 165;
  for (let i = 0; i < maxAttempts; i++) {
    await delay(2000);

    const pollResponse = await fetchFn(`/api/compose/jobs/${job.jobId}`);
    if (!pollResponse.ok) {
      throw new Error(
        `Failed to check build status: ${pollResponse.statusText}`,
      );
    }

    const status = (await pollResponse.json()) as ComposeJobResponse;
    if (status.status === "completed") {
      return status;
    }
    if (status.status === "failed") {
      throw new Error(status.error ?? "Build failed");
    }
  }

  throw new Error("Build timed out");
}
