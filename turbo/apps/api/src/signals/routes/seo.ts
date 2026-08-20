import { seoContract } from "@okouai/api-contracts/contracts/seo";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { seo$ } from "../services/seo.service";

const serpBody$ = bodyResultOf(seoContract.serp);
const keywordIdeasBody$ = bodyResultOf(seoContract.keywordIdeas);
const rankedKeywordsBody$ = bodyResultOf(seoContract.rankedKeywords);
const backlinksSummaryBody$ = bodyResultOf(seoContract.backlinksSummary);

const serpInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(serpBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    seo$,
    { auth, request: { operation: "serp", body: bodyResult.data } },
    signal,
  );
});

const keywordIdeasInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(keywordIdeasBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      seo$,
      {
        auth,
        request: { operation: "keyword-ideas", body: bodyResult.data },
      },
      signal,
    );
  },
);

const rankedKeywordsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(rankedKeywordsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      seo$,
      {
        auth,
        request: { operation: "ranked-keywords", body: bodyResult.data },
      },
      signal,
    );
  },
);

const backlinksSummaryInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(backlinksSummaryBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      seo$,
      {
        auth,
        request: { operation: "backlinks-summary", body: bodyResult.data },
      },
      signal,
    );
  },
);

const seoAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "seo:read",
  runUsageBarrier: true,
} as const;

export const seoRoutes: readonly RouteEntry[] = [
  {
    route: seoContract.serp,
    handler: authRoute(seoAuth, serpInner$),
  },
  {
    route: seoContract.keywordIdeas,
    handler: authRoute(seoAuth, keywordIdeasInner$),
  },
  {
    route: seoContract.rankedKeywords,
    handler: authRoute(seoAuth, rankedKeywordsInner$),
  },
  {
    route: seoContract.backlinksSummary,
    handler: authRoute(seoAuth, backlinksSummaryInner$),
  },
];
