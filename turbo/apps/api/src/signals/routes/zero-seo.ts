import { zeroSeoContract } from "@okouai/api-contracts/contracts/zero-seo";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroSeo$ } from "../services/zero-seo.service";

const serpBody$ = bodyResultOf(zeroSeoContract.serp);
const keywordIdeasBody$ = bodyResultOf(zeroSeoContract.keywordIdeas);
const rankedKeywordsBody$ = bodyResultOf(zeroSeoContract.rankedKeywords);
const backlinksSummaryBody$ = bodyResultOf(zeroSeoContract.backlinksSummary);

const serpInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(serpBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(
    zeroSeo$,
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
      zeroSeo$,
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
      zeroSeo$,
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
      zeroSeo$,
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
} as const;

export const zeroSeoRoutes: readonly RouteEntry[] = [
  {
    route: zeroSeoContract.serp,
    handler: authRoute(seoAuth, serpInner$),
  },
  {
    route: zeroSeoContract.keywordIdeas,
    handler: authRoute(seoAuth, keywordIdeasInner$),
  },
  {
    route: zeroSeoContract.rankedKeywords,
    handler: authRoute(seoAuth, rankedKeywordsInner$),
  },
  {
    route: zeroSeoContract.backlinksSummary,
    handler: authRoute(seoAuth, backlinksSummaryInner$),
  },
];
