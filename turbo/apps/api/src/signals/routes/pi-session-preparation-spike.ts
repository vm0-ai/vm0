import {
  formatPiSkillCatalogForPrompt,
  MemoryPiSession,
} from "@okouai/pi-agent-runtime";
import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { command } from "ccstate";
import { z } from "zod";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const c = initContract();

const preparationBodySchema = z.object({
  entry_count: z.int().min(0).max(20_000),
  content_bytes: z.int().min(0).max(1024),
  skill_count: z.int().min(0).max(1000).default(100),
});

const preparationResponseSchema = z.object({
  ok: z.literal(true),
  entry_count: z.int().nonnegative(),
  message_count: z.int().nonnegative(),
  skill_count: z.int().nonnegative(),
  input_bytes: z.int().nonnegative(),
  output_bytes: z.int().nonnegative(),
  generation_ms: z.number().nonnegative(),
  parse_ms: z.number().nonnegative(),
  context_ms: z.number().nonnegative(),
  serialize_ms: z.number().nonnegative(),
  skill_discovery_ms: z.number().nonnegative(),
  total_preparation_ms: z.number().nonnegative(),
  rss_mb: z.number().nonnegative(),
  filesystem_materialized: z.literal(false),
});

const piSessionPreparationSpikeContract = c.router({
  run: {
    method: "POST",
    path: "/api/test/pi-session-preparation-spike",
    body: preparationBodySchema,
    responses: {
      200: preparationResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Measure filesystem-free Pi session preparation in preview",
  },
});

const preparationBody$ = bodyResultOf(piSessionPreparationSpikeContract.run);
const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const SESSION_CWD = "/home/user/workspace";
const SKILL_ROOT = "/home/user/.pi/agent/skills";

function syntheticSessionJsonl(
  entryCount: number,
  contentBytes: number,
): string {
  const session = MemoryPiSession.create({
    cwd: SESSION_CWD,
    id: SESSION_ID,
  });
  const content = "x".repeat(contentBytes);
  for (let index = 0; index < entryCount; index += 1) {
    session.appendMessage({
      role: "user",
      content,
      timestamp: index,
    });
  }
  return session.toJsonl();
}

function syntheticSkills(skillCount: number) {
  return Array.from({ length: skillCount }, (_, index) => {
    return {
      name: `spike-skill-${index.toString()}`,
      slug: `spike-skill-${index.toString()}`,
      description: `Synthetic discovery metadata ${index.toString()}`,
    };
  });
}

const runPiSessionPreparationSpike$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(preparationBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const startedAt = performance.now();
    const generationStartedAt = performance.now();
    const jsonl = syntheticSessionJsonl(
      bodyResult.data.entry_count,
      bodyResult.data.content_bytes,
    );
    const generationMs = performance.now() - generationStartedAt;

    const parseStartedAt = performance.now();
    const session = MemoryPiSession.fromJsonl(jsonl);
    const parseMs = performance.now() - parseStartedAt;

    const contextStartedAt = performance.now();
    const context = session.buildSessionContext();
    const contextMs = performance.now() - contextStartedAt;

    const serializeStartedAt = performance.now();
    const outputJsonl = session.toJsonl();
    const serializeMs = performance.now() - serializeStartedAt;

    const skillStartedAt = performance.now();
    formatPiSkillCatalogForPrompt({
      skillRoot: SKILL_ROOT,
      skills: syntheticSkills(bodyResult.data.skill_count),
    });
    const skillDiscoveryMs = performance.now() - skillStartedAt;
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        entry_count: bodyResult.data.entry_count,
        message_count: context.messages.length,
        skill_count: bodyResult.data.skill_count,
        input_bytes: Buffer.byteLength(jsonl),
        output_bytes: Buffer.byteLength(outputJsonl),
        generation_ms: generationMs,
        parse_ms: parseMs,
        context_ms: contextMs,
        serialize_ms: serializeMs,
        skill_discovery_ms: skillDiscoveryMs,
        total_preparation_ms: performance.now() - startedAt,
        rss_mb: process.memoryUsage().rss / 1024 / 1024,
        filesystem_materialized: false as const,
      },
    };
  },
);

export const piSessionPreparationSpikeRoutes: readonly RouteEntry[] = [
  {
    route: piSessionPreparationSpikeContract.run,
    handler: runPiSessionPreparationSpike$,
  },
];
