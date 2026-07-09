import { command, computed } from "ccstate";
import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { notFound } from "../../lib/error";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroMemoryDetail } from "../services/zero-memory-detail.service";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  getMemorySourceDetail,
  listMemorySources,
} from "../services/memory-substrate.service";
import {
  getZeroMemoryContext,
  recallZeroMemory,
} from "../services/zero-memory-recall.service";
import { searchZeroMemory } from "../services/zero-memory-search.service";
import {
  createMemory as createLifecycleMemory,
  forgetByPrompt,
  forgetDocument,
  forgetMemory,
  listForgottenMemory,
  listMemories,
  listMemoryDocuments,
  listMemoryHistory,
  listMemoryProfiles,
  updateMemory as updateLifecycleMemory,
} from "../services/zero-memory-lifecycle.service";
import { buildZeroMemoryRuntimeInjection } from "../services/zero-memory-injection.service";
import {
  getSlackMemoryStatus,
  restartSlackMemoryBackfill,
  stopSlackMemoryBackfill,
} from "../services/slack-memory-backfill.service";
import {
  configureGithubMemory,
  getGithubMemoryStatus,
  listGithubMemoryContributors,
  listGithubMemoryRepositories,
  restartGithubMemoryBackfill,
  stopGithubMemoryBackfill,
} from "../services/github-memory-backfill.service";
import {
  getNotionMemoryStatus,
  restartNotionMemoryBackfill,
  stopNotionMemoryBackfill,
} from "../services/notion-memory-backfill.service";

const memoryAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const memoryRecallAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "relationship:read",
} as const;

const memorySourceDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Relationship memory is not enabled for this organization.",
      code: "FORBIDDEN",
    }),
  }),
});

const memoryRuntimeInjectionDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message:
        "Relationship memory runtime injection is not enabled for this organization.",
      code: "FORBIDDEN",
    }),
  }),
});

async function loadMemoryFeatureState(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<{
  readonly relationshipMemoryEnabled: boolean;
  readonly runtimeInjectionEnabled: boolean;
}> {
  const context = await loadUserFeatureSwitchContext(db, orgId, userId);
  const relationshipMemoryEnabled = isFeatureEnabled(
    FeatureSwitchKey.RelationshipMemory,
    context,
  );
  return {
    relationshipMemoryEnabled,
    runtimeInjectionEnabled:
      relationshipMemoryEnabled &&
      isFeatureEnabled(
        FeatureSwitchKey.RelationshipMemoryRuntimeInjection,
        context,
      ),
  };
}

async function isMemorySourceEnabled(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const state = await loadMemoryFeatureState(db, orgId, userId);
  return state.relationshipMemoryEnabled;
}

const getMemoryInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const detail = await get(zeroMemoryDetail(auth.orgId, auth.userId));
  return {
    status: 200 as const,
    body: detail,
  };
});

const memoryRecallQuery$ = queryOf(zeroMemoryContract.recall);
const memorySearchQuery$ = queryOf(zeroMemoryContract.search);
const memoryListQuery$ = queryOf(zeroMemoryContract.memories);
const memoryCreateBody$ = bodyResultOf(zeroMemoryContract.createMemory);
const memoryUpdateParams$ = pathParamsOf(zeroMemoryContract.updateMemory);
const memoryUpdateBody$ = bodyResultOf(zeroMemoryContract.updateMemory);
const memoryForgetParams$ = pathParamsOf(zeroMemoryContract.forgetMemory);
const memoryForgetBody$ = bodyResultOf(zeroMemoryContract.forgetMemory);
const memoryDocumentsQuery$ = queryOf(zeroMemoryContract.documents);
const memoryDocumentForgetParams$ = pathParamsOf(
  zeroMemoryContract.forgetDocument,
);
const memoryDocumentForgetBody$ = bodyResultOf(
  zeroMemoryContract.forgetDocument,
);
const memoryForgetPromptBody$ = bodyResultOf(zeroMemoryContract.forgetPrompt);
const memoryHistoryQuery$ = queryOf(zeroMemoryContract.history);
const memoryForgottenQuery$ = queryOf(zeroMemoryContract.forgotten);
const memoryProfilesQuery$ = queryOf(zeroMemoryContract.profiles);
const memoryContextQuery$ = queryOf(zeroMemoryContract.context);
const memoryInjectionPreviewBody$ = bodyResultOf(
  zeroMemoryContract.injectionPreview,
);
const memorySourcesQuery$ = queryOf(zeroMemoryContract.sources);
const memorySourceParams$ = pathParamsOf(zeroMemoryContract.source);
const slackBackfillBody$ = bodyResultOf(zeroMemoryContract.slackBackfill);
const githubRepositoriesQuery$ = queryOf(zeroMemoryContract.githubRepositories);
const githubContributorsQuery$ = queryOf(zeroMemoryContract.githubContributors);
const githubConfigureBody$ = bodyResultOf(zeroMemoryContract.githubConfigure);
const githubBackfillBody$ = bodyResultOf(zeroMemoryContract.githubBackfill);
const notionBackfillBody$ = bodyResultOf(zeroMemoryContract.notionBackfill);

const memoryRecallInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memoryRecallQuery$);
  const result = await recallZeroMemory(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    q: query.q,
    kind: query.kind,
    limit: query.limit,
  });
  return { status: 200 as const, body: result };
});

const memorySearchInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memorySearchQuery$);
  const result = await searchZeroMemory(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    q: query.q,
    mode: query.mode,
    provider: query.provider,
    sourceType: query.sourceType,
    contextSpaceType: query.contextSpaceType,
    contextSpaceKey: query.contextSpaceKey,
    memoryKind: query.memoryKind,
    occurredAfter: query.occurredAfter,
    occurredBefore: query.occurredBefore,
    limit: query.limit,
  });
  return { status: 200 as const, body: result };
});

const memoryListInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memoryListQuery$);
  const result = await listMemories(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    status: query.status,
    kind: query.kind,
    page: query.page,
    limit: query.limit,
  });
  return { status: 200 as const, body: result };
});

const memoryCreateInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const bodyResult = await get(memoryCreateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const memory = await createLifecycleMemory(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    });
    signal.throwIfAborted();
    return { status: 200 as const, body: { memory } };
  },
);

const memoryUpdateInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const bodyResult = await get(memoryUpdateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const params = get(memoryUpdateParams$);
    const memory = await updateLifecycleMemory(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      memoryId: params.memoryId,
      ...bodyResult.data,
    });
    signal.throwIfAborted();
    if (!memory) {
      return notFound("Memory not found");
    }
    return { status: 200 as const, body: { memory } };
  },
);

const memoryForgetInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const bodyResult = await get(memoryForgetBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const params = get(memoryForgetParams$);
    const forgotten = await forgetMemory(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      memoryId: params.memoryId,
      reason: bodyResult.data.reason,
    });
    signal.throwIfAborted();
    if (!forgotten) {
      return notFound("Memory not found");
    }
    return { status: 200 as const, body: { forgotten } };
  },
);

const memoryDocumentsInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memoryDocumentsQuery$);
  const result = await listMemoryDocuments(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    status: query.status,
    provider: query.provider,
    page: query.page,
    limit: query.limit,
  });
  return { status: 200 as const, body: result };
});

const memoryDocumentForgetInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const bodyResult = await get(memoryDocumentForgetBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const params = get(memoryDocumentForgetParams$);
    const forgotten = await forgetDocument(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      documentId: params.documentId,
      reason: bodyResult.data.reason,
    });
    signal.throwIfAborted();
    if (!forgotten) {
      return notFound("Memory document not found");
    }
    return { status: 200 as const, body: { forgotten } };
  },
);

const memoryForgetPromptInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const bodyResult = await get(memoryForgetPromptBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await forgetByPrompt(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    });
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  },
);

const memoryHistoryInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memoryHistoryQuery$);
  const result = await listMemoryHistory(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    targetKind: query.targetKind,
    targetId: query.targetId,
    limit: query.limit,
  });
  return { status: 200 as const, body: result };
});

const memoryForgottenInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memoryForgottenQuery$);
  const result = await listForgottenMemory(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    targetKind: query.targetKind,
    limit: query.limit,
  });
  return { status: 200 as const, body: result };
});

const memoryProfilesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memoryProfilesQuery$);
  const result = await listMemoryProfiles(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    limit: query.limit,
  });
  return { status: 200 as const, body: result };
});

const memoryContextInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memoryContextQuery$);
  const result = await getZeroMemoryContext(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    q: query.q,
    limit: query.limit,
  });
  return { status: 200 as const, body: result };
});

const memoryInjectionPreviewInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const featureState = await loadMemoryFeatureState(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  if (!featureState.relationshipMemoryEnabled) {
    return memorySourceDisabled;
  }
  if (!featureState.runtimeInjectionEnabled) {
    return memoryRuntimeInjectionDisabled;
  }

  const bodyResult = await get(memoryInjectionPreviewBody$);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await buildZeroMemoryRuntimeInjection(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    prompt: bodyResult.data.prompt,
  });
  return { status: 200 as const, body: result };
});

const memorySourcesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const query = get(memorySourcesQuery$);
  const result = await listMemorySources(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    provider: query.provider,
    page: query.page,
    limit: query.limit,
  });

  return {
    status: 200 as const,
    body: result,
  };
});

const memorySourceInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const params = get(memorySourceParams$);
  const result = await getMemorySourceDetail(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    sourceId: params.sourceId,
  });

  if (!result) {
    return notFound("Memory source not found");
  }

  return { status: 200 as const, body: result };
});

const slackStatusInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const result = await getSlackMemoryStatus(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  return { status: 200 as const, body: result };
});

const slackBackfillInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }
    signal.throwIfAborted();

    const bodyResult = await get(slackBackfillBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await restartSlackMemoryBackfill({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      options: bodyResult.data,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return {
        status: 400 as const,
        body: {
          error: {
            message: result.message,
            code: "BAD_REQUEST",
          },
        },
      };
    }

    return { status: 200 as const, body: result.status };
  },
);

const slackStopBackfillInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }
    signal.throwIfAborted();

    const result = await stopSlackMemoryBackfill({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return {
        status: 400 as const,
        body: {
          error: {
            message: result.message,
            code: "BAD_REQUEST",
          },
        },
      };
    }

    return { status: 200 as const, body: result.status };
  },
);

function badRequest(message: string): unknown {
  return {
    status: 400 as const,
    body: {
      error: {
        message,
        code: "BAD_REQUEST",
      },
    },
  };
}

const githubStatusInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const result = await getGithubMemoryStatus(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  return { status: 200 as const, body: result };
});

const githubRepositoriesInner$ = command(
  async ({ get }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }
    const query = get(githubRepositoriesQuery$);
    const result = await listGithubMemoryRepositories({
      db: get(db$),
      orgId: auth.orgId,
      userId: auth.userId,
      page: query.page,
      limit: query.limit,
      signal,
    });
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  },
);

const githubContributorsInner$ = command(
  async ({ get }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }
    const query = get(githubContributorsQuery$);
    const result = await listGithubMemoryContributors({
      db: get(db$),
      orgId: auth.orgId,
      userId: auth.userId,
      repository: query.repository,
      page: query.page,
      limit: query.limit,
      signal,
    });
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  },
);

const githubConfigureInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const bodyResult = await get(githubConfigureBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await configureGithubMemory({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      options: bodyResult.data,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return badRequest(result.message);
    }

    return { status: 200 as const, body: result.status };
  },
);

const githubBackfillInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const bodyResult = await get(githubBackfillBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await restartGithubMemoryBackfill({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      options: bodyResult.data,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return badRequest(result.message);
    }

    return { status: 200 as const, body: result.status };
  },
);

const githubStopBackfillInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const result = await stopGithubMemoryBackfill({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return badRequest(result.message);
    }

    return { status: 200 as const, body: result.status };
  },
);

const notionStatusInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
    return memorySourceDisabled;
  }

  const result = await getNotionMemoryStatus(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  return { status: 200 as const, body: result };
});

const notionBackfillInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const bodyResult = await get(notionBackfillBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await restartNotionMemoryBackfill({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      options: bodyResult.data,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return badRequest(result.message);
    }

    return { status: 200 as const, body: result.status };
  },
);

const notionStopBackfillInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isMemorySourceEnabled(get(db$), auth.orgId, auth.userId))) {
      return memorySourceDisabled;
    }

    const result = await stopNotionMemoryBackfill({
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      signal,
    });
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return badRequest(result.message);
    }

    return { status: 200 as const, body: result.status };
  },
);

export const zeroMemoryRoutes: readonly RouteEntry[] = [
  {
    route: zeroMemoryContract.get,
    handler: authRoute(memoryAuthOptions, getMemoryInner$),
  },
  {
    route: zeroMemoryContract.recall,
    handler: authRoute(memoryRecallAuthOptions, memoryRecallInner$),
  },
  {
    route: zeroMemoryContract.search,
    handler: authRoute(memoryRecallAuthOptions, memorySearchInner$),
  },
  {
    route: zeroMemoryContract.memories,
    handler: authRoute(memoryRecallAuthOptions, memoryListInner$),
  },
  {
    route: zeroMemoryContract.createMemory,
    handler: authRoute(memoryRecallAuthOptions, memoryCreateInner$),
  },
  {
    route: zeroMemoryContract.updateMemory,
    handler: authRoute(memoryRecallAuthOptions, memoryUpdateInner$),
  },
  {
    route: zeroMemoryContract.forgetMemory,
    handler: authRoute(memoryRecallAuthOptions, memoryForgetInner$),
  },
  {
    route: zeroMemoryContract.documents,
    handler: authRoute(memoryRecallAuthOptions, memoryDocumentsInner$),
  },
  {
    route: zeroMemoryContract.forgetDocument,
    handler: authRoute(memoryRecallAuthOptions, memoryDocumentForgetInner$),
  },
  {
    route: zeroMemoryContract.forgetPrompt,
    handler: authRoute(memoryRecallAuthOptions, memoryForgetPromptInner$),
  },
  {
    route: zeroMemoryContract.history,
    handler: authRoute(memoryRecallAuthOptions, memoryHistoryInner$),
  },
  {
    route: zeroMemoryContract.forgotten,
    handler: authRoute(memoryRecallAuthOptions, memoryForgottenInner$),
  },
  {
    route: zeroMemoryContract.profiles,
    handler: authRoute(memoryRecallAuthOptions, memoryProfilesInner$),
  },
  {
    route: zeroMemoryContract.context,
    handler: authRoute(memoryRecallAuthOptions, memoryContextInner$),
  },
  {
    route: zeroMemoryContract.injectionPreview,
    handler: authRoute(memoryRecallAuthOptions, memoryInjectionPreviewInner$),
  },
  {
    route: zeroMemoryContract.sources,
    handler: authRoute(memoryAuthOptions, memorySourcesInner$),
  },
  {
    route: zeroMemoryContract.source,
    handler: authRoute(memoryAuthOptions, memorySourceInner$),
  },
  {
    route: zeroMemoryContract.slackStatus,
    handler: authRoute(memoryAuthOptions, slackStatusInner$),
  },
  {
    route: zeroMemoryContract.slackBackfill,
    handler: authRoute(memoryAuthOptions, slackBackfillInner$),
  },
  {
    route: zeroMemoryContract.slackStopBackfill,
    handler: authRoute(memoryAuthOptions, slackStopBackfillInner$),
  },
  {
    route: zeroMemoryContract.githubStatus,
    handler: authRoute(memoryAuthOptions, githubStatusInner$),
  },
  {
    route: zeroMemoryContract.githubRepositories,
    handler: authRoute(memoryAuthOptions, githubRepositoriesInner$),
  },
  {
    route: zeroMemoryContract.githubContributors,
    handler: authRoute(memoryAuthOptions, githubContributorsInner$),
  },
  {
    route: zeroMemoryContract.githubConfigure,
    handler: authRoute(memoryAuthOptions, githubConfigureInner$),
  },
  {
    route: zeroMemoryContract.githubBackfill,
    handler: authRoute(memoryAuthOptions, githubBackfillInner$),
  },
  {
    route: zeroMemoryContract.githubStopBackfill,
    handler: authRoute(memoryAuthOptions, githubStopBackfillInner$),
  },
  {
    route: zeroMemoryContract.notionStatus,
    handler: authRoute(memoryAuthOptions, notionStatusInner$),
  },
  {
    route: zeroMemoryContract.notionBackfill,
    handler: authRoute(memoryAuthOptions, notionBackfillInner$),
  },
  {
    route: zeroMemoryContract.notionStopBackfill,
    handler: authRoute(memoryAuthOptions, notionStopBackfillInner$),
  },
];
