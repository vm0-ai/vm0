/**
 * Test fixtures for retired agent-compose API capabilities.
 *
 * Production no longer exposes direct compose creation or legacy compose
 * reads, while integration suites still need those services to construct and
 * inspect state. Keep the exception at this narrow service boundary and assert
 * product behavior through the remaining production routes.
 */
import { createStore } from "ccstate";
import type {
  ComposeResponse,
  agentComposeApiContentSchema,
} from "@vm0/api-contracts/contracts/composes";
import type { ApiErrorResponse } from "@vm0/api-contracts/contracts/errors";
import type { z } from "zod";

import { createAgentCompose$ } from "../signals/services/agent-composes-create.service";
import {
  agentComposeById,
  agentComposeByName,
  agentComposeVersionResolution,
} from "../signals/services/agent-composes-read.service";

const store = createStore();

type ComposeFixtureContent = z.infer<typeof agentComposeApiContentSchema>;

interface ComposeFixtureActor {
  readonly userId: string;
  readonly orgId: string;
}

type ComposeFixtureCreateResponse =
  | {
      readonly status: 200 | 201;
      readonly body: {
        readonly composeId: string;
        readonly name: string;
        readonly versionId: string;
        readonly action: "created" | "existing";
        readonly updatedAt: string;
      };
    }
  | {
      readonly status: 400;
      readonly body: ApiErrorResponse;
    };

type ComposeFixtureReadResponse =
  | {
      readonly status: 200;
      readonly body: ComposeResponse;
    }
  | {
      readonly status: 404;
      readonly body: ApiErrorResponse;
    };

type ComposeFixtureVersionResponse =
  | {
      readonly status: 200;
      readonly body: {
        readonly versionId: string;
        readonly tag?: string;
      };
    }
  | {
      readonly status: 400;
      readonly body: ApiErrorResponse;
    }
  | {
      readonly status: 404;
      readonly body: ApiErrorResponse;
    };

function notFound(message: string): {
  readonly status: 404;
  readonly body: ApiErrorResponse;
} {
  return {
    status: 404,
    body: { error: { message, code: "NOT_FOUND" } },
  };
}

export async function createAgentComposeFixture(args: {
  readonly actor: ComposeFixtureActor;
  readonly content: ComposeFixtureContent;
  readonly signal: AbortSignal;
}): Promise<ComposeFixtureCreateResponse> {
  return await store.set(
    createAgentCompose$,
    {
      userId: args.actor.userId,
      orgId: args.actor.orgId,
      content: args.content,
    },
    args.signal,
  );
}

export async function readAgentComposeByNameFixture(args: {
  readonly actor: ComposeFixtureActor;
  readonly name: string;
}): Promise<ComposeFixtureReadResponse> {
  const compose = await store.get(
    agentComposeByName({ orgId: args.actor.orgId, name: args.name }),
  );
  return compose
    ? { status: 200, body: compose }
    : notFound(`Agent compose not found: ${args.name}`);
}

export async function readAgentComposeByIdFixture(args: {
  readonly actor: ComposeFixtureActor;
  readonly composeId: string;
}): Promise<ComposeFixtureReadResponse> {
  const compose = await store.get(
    agentComposeById({
      composeId: args.composeId,
      userId: args.actor.userId,
      orgId: args.actor.orgId,
    }),
  );
  return compose
    ? { status: 200, body: compose }
    : notFound("Agent compose not found");
}

export async function resolveAgentComposeVersionFixture(args: {
  readonly actor: ComposeFixtureActor;
  readonly composeId: string;
  readonly version: string;
}): Promise<ComposeFixtureVersionResponse> {
  const result = await store.get(
    agentComposeVersionResolution({
      composeId: args.composeId,
      userId: args.actor.userId,
      version: args.version,
    }),
  );
  return "status" in result ? result : { status: 200, body: result };
}
