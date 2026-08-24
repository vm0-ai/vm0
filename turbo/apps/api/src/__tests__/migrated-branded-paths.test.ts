import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createAppWithRoutes } from "../app-factory-core";
import { ROUTES } from "../signals/route";
import { billingStatusRoutes } from "../signals/routes/billing-status";
import { featureSwitchesRoutes } from "../signals/routes/feature-switches";
import { feishuConnectRoutes } from "../signals/routes/feishu-connect";
import { orgReadRoutes } from "../signals/routes/org-read";
import { slackChannelsRoutes } from "../signals/routes/slack-channels";
import { slackConnectRoutes } from "../signals/routes/slack-connect";
import { slackOauthRoutes } from "../signals/routes/slack-oauth";
import { strapiIntegrationsRoutes } from "../signals/routes/strapi-integrations";
import { teamsBotRoutes } from "../signals/routes/teams-bot";
import { teamsOauthRoutes } from "../signals/routes/teams-oauth";
import { uploadsPrepareRoutes } from "../signals/routes/uploads-prepare";
import { voiceIoQuotaRoutes } from "../signals/routes/voice-io-quota";
import { weatherRoutes } from "../signals/routes/weather";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
  withMigratedBrandedPaths,
} from "../signals/route-entry";
import { testContext } from "./test-context";

const c = initContract();
const REQUEST_ORIGIN = "http://api.test";

// Synthetic contracts rather than real ones, so a later migration slice cannot
// quietly change what these mechanism tests assert. The shipped table is
// covered separately, against the real route table, further down.
const migrationContract = c.router({
  // The shape a migrated contract has: the neutral path it declares after
  // #28278 moves it off `/api/okou/**`.
  neutral: {
    method: "POST",
    path: "/api/synthetic/thing",
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  // The same route before the move, and the collision a careless row causes.
  branded: {
    method: "POST",
    path: "/api/okou/synthetic/thing",
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  // A neutral route no row names, standing in for the ~354 paths the table must
  // leave alone.
  unnamed: {
    method: "POST",
    path: "/api/synthetic/other",
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
});

function servedHandler() {
  return computed(() => {
    return { status: 200 as const, body: { served: true as const } };
  });
}

// One handler per route, so asserting that a produced registration carries the
// declaring route's handler is a real assertion rather than a coincidence.
const NEUTRAL_ROUTE: Readonly<RouteEntry> = {
  route: migrationContract.neutral,
  handler: servedHandler(),
};
const BRANDED_ROUTE: Readonly<RouteEntry> = {
  route: migrationContract.branded,
  handler: servedHandler(),
};
const UNNAMED_ROUTE: Readonly<RouteEntry> = {
  route: migrationContract.unnamed,
  handler: servedHandler(),
};

// Input to the mechanism, never an expectation: every expected path below is
// written out again inside the test that asserts it.
const MIGRATED_TABLE: Readonly<Record<string, readonly string[]>> = {
  "/api/synthetic/thing": [
    "/api/okou/synthetic/thing",
    "/api/zero/synthetic/thing",
  ],
};

// The maps operations that still owe a branded form. #28417 moved seven off
// `/api/okou/maps/**`; #28709 removed the six that took no branded request in
// the retained window, leaving the one a published CLI was still calling.
// Written out rather than read from `mapsContract` or `MIGRATED_BRANDED_PATHS`,
// so dropping a contract path or a table row fails the test that uses this.
const MAPS_OPERATIONS = ["geocode"] as const;

// The weather twin of the list above: #28357 moved five operations off
// `/api/okou/weather/**` and #28709 kept only the one with measured traffic.
const WEATHER_OPERATIONS = ["current"] as const;

function registeredPaths(entries: readonly RouteEntry[]): readonly string[] {
  return entries.map((entry) => {
    return entry.route.path;
  });
}

// The paths a released caller of the synthetic route holds. Restated here
// rather than read back from the table or from `apiNamespaceAliasPaths`, so
// this stays true when the registration that serves them disappears.
const BRANDED_PATHS_OWED = [
  "/api/okou/synthetic/thing",
  "/api/zero/synthetic/thing",
] as const;

// Every route a #28278 slice has moved off `/api/okou/**`, keyed by the
// neutral path its contract declares now and holding the two branded paths
// released callers still reach it at. Restated here rather than read back
// from `MIGRATED_BRANDED_PATHS` or derived from `apiNamespaceAliasPaths`: the
// table is what a migration edits, and the function returns a neutral path
// unchanged, so an expectation taken from either asserts nothing. Each slice
// appends its own rows.
const MIGRATED_ROUTE_PATHS: Readonly<Record<string, readonly string[]>> = {
  // #28421
  "/api/me/model-provider-accounts/:id/activate": [
    "/api/okou/me/model-provider-accounts/:id/activate",
    "/api/zero/me/model-provider-accounts/:id/activate",
  ],
  "/api/me/model-providers": [
    "/api/okou/me/model-providers",
    "/api/zero/me/model-providers",
  ],
  "/api/onboarding/complete": [
    "/api/okou/onboarding/complete",
    "/api/zero/onboarding/complete",
  ],
  "/api/onboarding/status": [
    "/api/okou/onboarding/status",
    "/api/zero/onboarding/status",
  ],
  "/api/team": ["/api/okou/team", "/api/zero/team"],
  "/api/user-model-preference": [
    "/api/okou/user-model-preference",
    "/api/zero/user-model-preference",
  ],
  "/api/user-preferences": [
    "/api/okou/user-preferences",
    "/api/zero/user-preferences",
  ],
  // #28418
  "/api/browsers/current": [
    "/api/okou/browsers/current",
    "/api/zero/browsers/current",
  ],
  "/api/browsers/lease": [
    "/api/okou/browsers/lease",
    "/api/zero/browsers/lease",
  ],
  "/api/finance/chart": ["/api/okou/finance/chart", "/api/zero/finance/chart"],
  "/api/finance/profile": [
    "/api/okou/finance/profile",
    "/api/zero/finance/profile",
  ],
  "/api/finance/quote": ["/api/okou/finance/quote", "/api/zero/finance/quote"],
  "/api/seo/backlinks-summary": [
    "/api/okou/seo/backlinks-summary",
    "/api/zero/seo/backlinks-summary",
  ],
  "/api/seo/keyword-ideas": [
    "/api/okou/seo/keyword-ideas",
    "/api/zero/seo/keyword-ideas",
  ],
  // #28415
  // #28416
  // #28419
  // #28420: chat-thread drafts and unreads, agent/thread indicators, and signup
  // attribution.
  "/api/attribution/signup": [
    "/api/okou/attribution/signup",
    "/api/zero/attribution/signup",
  ],
  "/api/chat-thread-drafts": [
    "/api/okou/chat-thread-drafts",
    "/api/zero/chat-thread-drafts",
  ],
  "/api/chat-thread-unreads": [
    "/api/okou/chat-thread-unreads",
    "/api/zero/chat-thread-unreads",
  ],
  "/api/chat-thread-unreads/mark-read": [
    "/api/okou/chat-thread-unreads/mark-read",
    "/api/zero/chat-thread-unreads/mark-read",
  ],
  "/api/indicators": ["/api/okou/indicators", "/api/zero/indicators"],
  // #28422
  "/api/artifacts/catalog/:artifactId": [
    "/api/okou/artifacts/catalog/:artifactId",
    "/api/zero/artifacts/catalog/:artifactId",
  ],
  "/api/logs/:id": ["/api/okou/logs/:id", "/api/zero/logs/:id"],
  "/api/realtime/token": [
    "/api/okou/realtime/token",
    "/api/zero/realtime/token",
  ],
  "/api/runs/:id": ["/api/okou/runs/:id", "/api/zero/runs/:id"],
  "/api/runs/:id/context": [
    "/api/okou/runs/:id/context",
    "/api/zero/runs/:id/context",
  ],
  "/api/runs/:id/network": [
    "/api/okou/runs/:id/network",
    "/api/zero/runs/:id/network",
  ],
  "/api/runs/:id/runner": [
    "/api/okou/runs/:id/runner",
    "/api/zero/runs/:id/runner",
  ],
  "/api/runs/queue": ["/api/okou/runs/queue", "/api/zero/runs/queue"],
  // #28459: chat threads, chat events and search, shared threads,
  // per-thread browser sessions and goals, thread workflow automations,
  // queue position, and the X image share.
  "/api/chat-threads": ["/api/okou/chat-threads", "/api/zero/chat-threads"],
  "/api/chat-threads/:id": [
    "/api/okou/chat-threads/:id",
    "/api/zero/chat-threads/:id",
  ],
  "/api/chat-threads/:id/computer-use-host": [
    "/api/okou/chat-threads/:id/computer-use-host",
    "/api/zero/chat-threads/:id/computer-use-host",
  ],
  "/api/chat-threads/:id/draft": [
    "/api/okou/chat-threads/:id/draft",
    "/api/zero/chat-threads/:id/draft",
  ],
  "/api/chat-threads/:id/mark-read": [
    "/api/okou/chat-threads/:id/mark-read",
    "/api/zero/chat-threads/:id/mark-read",
  ],
  "/api/chat-threads/:id/pin": [
    "/api/okou/chat-threads/:id/pin",
    "/api/zero/chat-threads/:id/pin",
  ],
  "/api/chat-threads/:id/unpin": [
    "/api/okou/chat-threads/:id/unpin",
    "/api/zero/chat-threads/:id/unpin",
  ],
  "/api/chat-threads/:threadId/artifacts": [
    "/api/okou/chat-threads/:threadId/artifacts",
    "/api/zero/chat-threads/:threadId/artifacts",
  ],
  "/api/chat-threads/:threadId/browser": [
    "/api/okou/chat-threads/:threadId/browser",
    "/api/zero/chat-threads/:threadId/browser",
  ],
  "/api/chat-threads/:threadId/event-rows": [
    "/api/okou/chat-threads/:threadId/event-rows",
    "/api/zero/chat-threads/:threadId/event-rows",
  ],
  "/api/chat-threads/:threadId/event-snapshot": [
    "/api/okou/chat-threads/:threadId/event-snapshot",
    "/api/zero/chat-threads/:threadId/event-snapshot",
  ],
  "/api/chat-threads/:threadId/goal": [
    "/api/okou/chat-threads/:threadId/goal",
    "/api/zero/chat-threads/:threadId/goal",
  ],
  "/api/chat-threads/:threadId/goal/pause": [
    "/api/okou/chat-threads/:threadId/goal/pause",
    "/api/zero/chat-threads/:threadId/goal/pause",
  ],
  "/api/chat-threads/:threadId/workflow-automations": [
    "/api/okou/chat-threads/:threadId/workflow-automations",
    "/api/zero/chat-threads/:threadId/workflow-automations",
  ],
  "/api/chat-threads/events": [
    "/api/okou/chat-threads/events",
    "/api/zero/chat-threads/events",
  ],
  "/api/chat-threads/snapshot": [
    "/api/okou/chat-threads/snapshot",
    "/api/zero/chat-threads/snapshot",
  ],
  "/api/chat/events": ["/api/okou/chat/events", "/api/zero/chat/events"],
  // #28457: the billing surface.
  "/api/billing/concurrency-checkout": [
    "/api/okou/billing/concurrency-checkout",
    "/api/zero/billing/concurrency-checkout",
  ],
  "/api/billing/concurrency-checkout/preview": [
    "/api/okou/billing/concurrency-checkout/preview",
    "/api/zero/billing/concurrency-checkout/preview",
  ],
  "/api/billing/concurrency-subscriptions/:subscriptionId/changes/preview": [
    "/api/okou/billing/concurrency-subscriptions/:subscriptionId/changes/preview",
    "/api/zero/billing/concurrency-subscriptions/:subscriptionId/changes/preview",
  ],
  "/api/billing/credit-checkout/confirm": [
    "/api/okou/billing/credit-checkout/confirm",
    "/api/zero/billing/credit-checkout/confirm",
  ],
  "/api/billing/portal": [
    "/api/okou/billing/portal",
    "/api/zero/billing/portal",
  ],
  "/api/billing/redeem-code": [
    "/api/okou/billing/redeem-code",
    "/api/zero/billing/redeem-code",
  ],
  "/api/billing/restore": [
    "/api/okou/billing/restore",
    "/api/zero/billing/restore",
  ],
  "/api/billing/status": [
    "/api/okou/billing/status",
    "/api/zero/billing/status",
  ],
  "/api/billing/usage-pack-checkout": [
    "/api/okou/billing/usage-pack-checkout",
    "/api/zero/billing/usage-pack-checkout",
  ],
  "/api/billing/usage-pack-subscription/subscription-change/confirm": [
    "/api/okou/billing/usage-pack-subscription/subscription-change/confirm",
    "/api/zero/billing/usage-pack-subscription/subscription-change/confirm",
  ],
  "/api/billing/usage-pack-subscription/subscription-change/preview": [
    "/api/okou/billing/usage-pack-subscription/subscription-change/preview",
    "/api/zero/billing/usage-pack-subscription/subscription-change/preview",
  ],
  // #28466
  "/api/computer-use/audit-events": [
    "/api/okou/computer-use/audit-events",
    "/api/zero/computer-use/audit-events",
  ],
  "/api/computer-use/heartbeat": [
    "/api/okou/computer-use/heartbeat",
    "/api/zero/computer-use/heartbeat",
  ],
  "/api/computer-use/host/commands/:commandId/complete": [
    "/api/okou/computer-use/host/commands/:commandId/complete",
    "/api/zero/computer-use/host/commands/:commandId/complete",
  ],
  "/api/computer-use/host/commands/next": [
    "/api/okou/computer-use/host/commands/next",
    "/api/zero/computer-use/host/commands/next",
  ],
  "/api/computer-use/host/stop": [
    "/api/okou/computer-use/host/stop",
    "/api/zero/computer-use/host/stop",
  ],
  "/api/computer-use/hosts": [
    "/api/okou/computer-use/hosts",
    "/api/zero/computer-use/hosts",
  ],
  "/api/computer-use/hosts/start": [
    "/api/okou/computer-use/hosts/start",
    "/api/zero/computer-use/hosts/start",
  ],
  // #28423
  "/api/integrations/feishu": [
    "/api/okou/integrations/feishu",
    "/api/zero/integrations/feishu",
  ],
  "/api/integrations/slack": [
    "/api/okou/integrations/slack",
    "/api/zero/integrations/slack",
  ],
  "/api/integrations/slack/connect": [
    "/api/okou/integrations/slack/connect",
    "/api/zero/integrations/slack/connect",
  ],
  "/api/integrations/slack/message": [
    "/api/okou/integrations/slack/message",
    "/api/zero/integrations/slack/message",
  ],
  "/api/integrations/slack/upload-file/complete": [
    "/api/okou/integrations/slack/upload-file/complete",
    "/api/zero/integrations/slack/upload-file/complete",
  ],
  "/api/integrations/slack/upload-file/init": [
    "/api/okou/integrations/slack/upload-file/init",
    "/api/zero/integrations/slack/upload-file/init",
  ],
  "/api/integrations/slack/upload-file/materialize": [
    "/api/okou/integrations/slack/upload-file/materialize",
    "/api/zero/integrations/slack/upload-file/materialize",
  ],
  "/api/integrations/strapi": [
    "/api/okou/integrations/strapi",
    "/api/zero/integrations/strapi",
  ],
  // #28460: the connector catalog, the connector connections, the custom
  // connectors, the model provider connections, and the user permission grants.
  "/api/connector-catalog/:connectorSlug": [
    "/api/okou/connector-catalog/:connectorSlug",
    "/api/zero/connector-catalog/:connectorSlug",
  ],
  "/api/connector-catalog/diagnostics": [
    "/api/okou/connector-catalog/diagnostics",
    "/api/zero/connector-catalog/diagnostics",
  ],
  "/api/connector-catalog/status": [
    "/api/okou/connector-catalog/status",
    "/api/zero/connector-catalog/status",
  ],
  "/api/connectors/:connectorSlug/manual-grant": [
    "/api/okou/connectors/:connectorSlug/manual-grant",
    "/api/zero/connectors/:connectorSlug/manual-grant",
  ],
  "/api/custom-connectors": [
    "/api/okou/custom-connectors",
    "/api/zero/custom-connectors",
  ],
  "/api/model-provider-connections": [
    "/api/okou/model-provider-connections",
    "/api/zero/model-provider-connections",
  ],
  "/api/user-permission-grants/apply": [
    "/api/okou/user-permission-grants/apply",
    "/api/zero/user-permission-grants/apply",
  ],
  // #28464: the Slack, Teams, and Feishu connect and OAuth-start routes. The
  // paths a provider console holds are not in this slice and stay branded;
  // they are covered by `provider-console-paths.test.ts`.
  "/api/slack/channels": [
    "/api/okou/slack/channels",
    "/api/zero/slack/channels",
  ],
  "/api/slack/oauth/connect": [
    "/api/okou/slack/oauth/connect",
    "/api/zero/slack/oauth/connect",
  ],
  "/api/slack/oauth/install": [
    "/api/okou/slack/oauth/install",
    "/api/zero/slack/oauth/install",
  ],
  // #28465. Keys hold their path parameters verbatim, because the table is
  // matched against `entry.route.path` rather than an expanded request path.
  "/api/desktop/updates/:channel/:platform/:arch/dmg": [
    "/api/okou/desktop/updates/:channel/:platform/:arch/dmg",
    "/api/zero/desktop/updates/:channel/:platform/:arch/dmg",
  ],
  "/api/desktop/updates/:channel/:platform/:arch/release": [
    "/api/okou/desktop/updates/:channel/:platform/:arch/release",
    "/api/zero/desktop/updates/:channel/:platform/:arch/release",
  ],
  // #28462: feature switches, model policies, org model providers and their
  // device-auth sessions, the org profile and membership routes, and the usage
  // reads.
  "/api/feature-switches": [
    "/api/okou/feature-switches",
    "/api/zero/feature-switches",
  ],
  "/api/model-policies": [
    "/api/okou/model-policies",
    "/api/zero/model-policies",
  ],
  "/api/model-providers/codex/device-auth/sessions": [
    "/api/okou/model-providers/codex/device-auth/sessions",
    "/api/zero/model-providers/codex/device-auth/sessions",
  ],
  "/api/model-providers/codex/device-auth/sessions/cancel": [
    "/api/okou/model-providers/codex/device-auth/sessions/cancel",
    "/api/zero/model-providers/codex/device-auth/sessions/cancel",
  ],
  "/api/model-providers/codex/device-auth/sessions/complete": [
    "/api/okou/model-providers/codex/device-auth/sessions/complete",
    "/api/zero/model-providers/codex/device-auth/sessions/complete",
  ],
  "/api/org": ["/api/okou/org", "/api/zero/org"],
  "/api/org/invite": ["/api/okou/org/invite", "/api/zero/org/invite"],
  "/api/org/invite/purchase/:purchaseId/confirm": [
    "/api/okou/org/invite/purchase/:purchaseId/confirm",
    "/api/zero/org/invite/purchase/:purchaseId/confirm",
  ],
  "/api/org/invite/purchase/preview": [
    "/api/okou/org/invite/purchase/preview",
    "/api/zero/org/invite/purchase/preview",
  ],
  "/api/usage/members": ["/api/okou/usage/members", "/api/zero/usage/members"],
  // #28461
  "/api/agents/:id": ["/api/okou/agents/:id", "/api/zero/agents/:id"],
  "/api/agents/:id/custom-connectors": [
    "/api/okou/agents/:id/custom-connectors",
    "/api/zero/agents/:id/custom-connectors",
  ],
  "/api/agents/:id/draft": [
    "/api/okou/agents/:id/draft",
    "/api/zero/agents/:id/draft",
  ],
  "/api/agents/:id/user-connectors": [
    "/api/okou/agents/:id/user-connectors",
    "/api/zero/agents/:id/user-connectors",
  ],
  "/api/workflow-automations/:id/disable": [
    "/api/okou/workflow-automations/:id/disable",
    "/api/zero/workflow-automations/:id/disable",
  ],
  "/api/workflow-automations/:id/enable": [
    "/api/okou/workflow-automations/:id/enable",
    "/api/zero/workflow-automations/:id/enable",
  ],
  "/api/workflows": ["/api/okou/workflows", "/api/zero/workflows"],
  // #28545: the Teams OAuth callback and the Teams bot ingress, moved off
  // `FINAL_PROVIDER_CONSOLE_PATHS` now that both Microsoft consoles hold the
  // final URL. `/api/zero/teams/oauth/callback` is still emitted on purpose by
  // the VM0 brand, so it is a producer target rather than drain-window
  // compatibility; `route-entry.ts` records why on the row.
  "/api/integrations/teams/oauth/callback": [
    "/api/okou/teams/oauth/callback",
    "/api/zero/teams/oauth/callback",
  ],
  "/api/webhooks/teams/bot": ["/api/okou/teams/bot", "/api/zero/teams/bot"],
  // #28463: avatar video, banking, browser authorization requests, inbound
  // email, the GitHub user-connect start, mail drafts, people search,
  // presentation templates, the Strapi webhook, uploads, video-io, voice-io and
  // the web file reads.
  "/api/browser/authorization-requests/:requestToken": [
    "/api/okou/browser/authorization-requests/:requestToken",
    "/api/zero/browser/authorization-requests/:requestToken",
  ],
  "/api/browser/authorization-requests/:requestToken/apply": [
    "/api/okou/browser/authorization-requests/:requestToken/apply",
    "/api/zero/browser/authorization-requests/:requestToken/apply",
  ],
  "/api/mail/drafts/:mailDraftId/send": [
    "/api/okou/mail/drafts/:mailDraftId/send",
    "/api/zero/mail/drafts/:mailDraftId/send",
  ],
  "/api/presentation-templates/:templateId": [
    "/api/okou/presentation-templates/:templateId",
    "/api/zero/presentation-templates/:templateId",
  ],
  "/api/uploads/multipart/abort": [
    "/api/okou/uploads/multipart/abort",
    "/api/zero/uploads/multipart/abort",
  ],
  "/api/uploads/prepare": [
    "/api/okou/uploads/prepare",
    "/api/zero/uploads/prepare",
  ],
  "/api/voice-io/quota": [
    "/api/okou/voice-io/quota",
    "/api/zero/voice-io/quota",
  ],
  "/api/voice-io/speech": [
    "/api/okou/voice-io/speech",
    "/api/zero/voice-io/speech",
  ],
  // #28544: the two Feishu routes that left `FINAL_PROVIDER_CONSOLE_PATHS`.
  // Both branded forms used to be the declared paths, so these rows are the
  // only thing registering them now — the events one is what keeps the two
  // production Feishu installations delivering to the URL each of them holds in
  // its own Feishu app console.
  "/api/webhooks/feishu/events/:installationId": [
    "/api/okou/feishu/events/:installationId",
    "/api/zero/feishu/events/:installationId",
  ],
  // #28565: the connector-account reads and writes and the managed SocialKit
  // request, the two contracts that were added while #28278 was in flight and
  // so appeared in no slice's inventory.
  // #28600: the Slack OAuth callback and the three inbound Slack webhooks, the
  // last contracts to leave the brand namespace. The Slack app configuration
  // holds one URL per endpoint and cannot be repointed from this repository, so
  // these rows are what keeps whichever form it holds answering; the callback's
  // `zero` form is additionally the `redirect_uri` `routes/slack-oauth.ts`
  // still emits.
  "/api/integrations/slack/oauth/callback": [
    "/api/okou/slack/oauth/callback",
    "/api/zero/slack/oauth/callback",
  ],
  "/api/webhooks/slack/events": [
    "/api/okou/slack/events",
    "/api/zero/slack/events",
  ],
  "/api/webhooks/slack/commands": [
    "/api/okou/slack/commands",
    "/api/zero/slack/commands",
  ],
  "/api/webhooks/slack/interactive": [
    "/api/okou/slack/interactive",
    "/api/zero/slack/interactive",
  ],
};

function missingBrandedPaths(
  routes: readonly RouteEntry[],
  brandedPaths: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  const registered = new Set(
    registeredPaths(
      withMigratedBrandedPaths(withApiNamespaceAliases(routes), brandedPaths),
    ),
  );
  return BRANDED_PATHS_OWED.filter((path) => {
    return !registered.has(path);
  });
}

// `withApiNamespaceAliases` derives a branded route's canonical namespace and
// leaves a neutral path alone, which is why a contract that moves to its
// neutral path loses both branded registrations. This file covers the table
// that gives them back: what it registers, what it must not touch, and the
// migration mistake it exists to make loud.
describe("branded paths for migrated neutral routes", () => {
  const context = testContext();

  it("registers the neutral path and every branded path a row names", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases([NEUTRAL_ROUTE]),
      MIGRATED_TABLE,
    );

    expect(registeredPaths(registered)).toStrictEqual([
      "/api/synthetic/thing",
      "/api/okou/synthetic/thing",
      "/api/zero/synthetic/thing",
    ]);
    for (const entry of registered) {
      expect(entry.handler).toBe(NEUTRAL_ROUTE.handler);
      expect(entry.route).toStrictEqual({
        ...NEUTRAL_ROUTE.route,
        path: entry.route.path,
      });
    }
  });

  // The table names paths one row at a time. If it ever derived them, it would
  // be a second blanket expansion, and #28278 would have gained nothing.
  it("registers only itself for a neutral path no row names", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases([UNNAMED_ROUTE]),
      MIGRATED_TABLE,
    );

    expect(registeredPaths(registered)).toStrictEqual(["/api/synthetic/other"]);
  });

  it("fails uniqueness when a row collides with a declared path", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases([NEUTRAL_ROUTE, BRANDED_ROUTE]),
      MIGRATED_TABLE,
    );

    expect(() => {
      assertUniqueRouteRegistrations(registered);
    }).toThrow(
      "Duplicate API route registration: POST /api/okou/synthetic/thing",
    );
  });

  // Pins the order `createAppWithRoutes` composes the two stages in. A row
  // names a finished registration, so producing the branded paths before the
  // blanket expansion would feed `/api/okou/synthetic/thing` back into it and
  // derive its sibling namespace a second time.
  it("registers each branded path once only when applied after the expansion", () => {
    const composed = withMigratedBrandedPaths(
      withApiNamespaceAliases([NEUTRAL_ROUTE]),
      MIGRATED_TABLE,
    );
    const reversed = withApiNamespaceAliases(
      withMigratedBrandedPaths([NEUTRAL_ROUTE], MIGRATED_TABLE),
    );

    expect(() => {
      assertUniqueRouteRegistrations(composed);
    }).not.toThrow();
    expect(() => {
      assertUniqueRouteRegistrations(reversed);
    }).toThrow(
      "Duplicate API route registration: POST /api/okou/synthetic/thing",
    );
  });

  // The failure a migration slice would otherwise take to production: the
  // contract moves, every mechanism assertion still holds, and both branded
  // paths 404 for callers running a released build. A row is the way out, and
  // adding one has to be deliberate.
  //
  // Since #28701 the expansion no longer derives an unlisted `/api/zero/**`
  // path, so a branded contract owes its legacy form to a table row even before
  // the move. The canonical form is what the move itself drops.
  it("reports the branded paths a move to a neutral path drops", () => {
    const beforeMove = missingBrandedPaths([BRANDED_ROUTE], {});
    const movedWithoutRow = missingBrandedPaths([NEUTRAL_ROUTE], {});
    const movedWithRow = missingBrandedPaths([NEUTRAL_ROUTE], MIGRATED_TABLE);

    expect(beforeMove).toStrictEqual(["/api/zero/synthetic/thing"]);
    expect(movedWithoutRow).toStrictEqual([
      "/api/okou/synthetic/thing",
      "/api/zero/synthetic/thing",
    ]);
    expect(movedWithRow).toStrictEqual([]);
  });

  // #28417 fills the table for maps. The contract declares the neutral paths,
  // so the blanket expansion no longer derives a branded form for them and
  // every branded maps path below exists only because of a table row. The paths
  // are written out here rather than derived from the table, so deleting a row
  // fails this test instead of changing what it asserts.
  it("serves the migrated maps routes on neutral and branded paths", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(ROUTES),
    );

    function requireRoute(path: string): RouteEntry {
      const matches = registered.filter((entry) => {
        return entry.route.method === "POST" && entry.route.path === path;
      });
      const match = matches[0];
      if (!match) {
        throw new Error(`Missing maps registration for POST ${path}`);
      }
      expect(matches).toHaveLength(1);
      return match;
    }

    for (const operation of MAPS_OPERATIONS) {
      const neutral = requireRoute(`/api/maps/${operation}`);

      // One contract route behind all three paths, so a branded form cannot
      // drift into a second handler or a stale schema.
      for (const namespace of ["okou", "zero"]) {
        const brandedPath = `/api/${namespace}/maps/${operation}`;
        const branded = requireRoute(brandedPath);

        expect(branded.handler).toBe(neutral.handler);
        expect(branded.route).toStrictEqual({
          ...neutral.route,
          path: brandedPath,
        });
      }
    }
  });

  // The weather twin of the assertion above (#28357). Kept as its own test so a
  // failure names the family that regressed, and so the paths stay written out
  // per family rather than derived from the table under test.
  it("serves the migrated weather routes on neutral and branded paths", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(ROUTES),
    );

    function requireRoute(path: string): RouteEntry {
      const matches = registered.filter((entry) => {
        return entry.route.method === "POST" && entry.route.path === path;
      });
      const match = matches[0];
      if (!match) {
        throw new Error(`Missing weather registration for POST ${path}`);
      }
      expect(matches).toHaveLength(1);
      return match;
    }

    for (const operation of WEATHER_OPERATIONS) {
      const neutral = requireRoute(`/api/weather/${operation}`);

      // One contract route behind all three paths, so a branded form cannot
      // drift into a second handler or a stale schema.
      for (const namespace of ["okou", "zero"]) {
        const brandedPath = `/api/${namespace}/weather/${operation}`;
        const branded = requireRoute(brandedPath);

        expect(branded.handler).toBe(neutral.handler);
        expect(branded.route).toStrictEqual({
          ...neutral.route,
          path: brandedPath,
        });
      }
    }
  });

  // The synthetic cases above cover the mechanism; this runs the real route
  // table through the composition production registers, so a moved contract
  // that lost its rows fails here rather than 404ing a released caller.
  it("serves every migrated route at its neutral path and both branded paths", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(ROUTES),
    );

    for (const [neutral, brandedPaths] of Object.entries(
      MIGRATED_ROUTE_PATHS,
    )) {
      const declared = ROUTES.filter((entry) => {
        return entry.route.path === neutral;
      });
      expect(
        declared.length,
        `Expected a contract declaring ${neutral}`,
      ).toBeGreaterThan(0);

      for (const source of declared) {
        for (const path of [neutral, ...brandedPaths]) {
          const key = `${source.route.method} ${path}`;
          const matches = registered.filter((entry) => {
            return (
              entry.route.method === source.route.method &&
              entry.route.path === path
            );
          });
          expect(matches, `Missing registration for ${key}`).toHaveLength(1);
          const match = matches[0];
          if (!match) {
            throw new Error(`Missing registration for ${key}`);
          }
          expect(match.handler).toBe(source.handler);
          expect(match.route).toStrictEqual({ ...source.route, path });
        }
      }
    }
  });

  // The #28423 twin: the integration control plane, driven through the same
  // production app factory. The registration assertion above rebuilds the
  // composition itself and so cannot see how `createAppWithRoutes` wires it —
  // if `withMigratedBrandedPaths` were dropped from or reordered in that chain,
  // every branded integration path would 404 here while that assertion still
  // passed. Requests are unauthenticated, so the status is whatever the auth
  // layer returns; the point is that all three forms reach the same handler.
  it("serves the migrated integration paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    // One GET per contract file this slice moved, written out rather than read
    // back from `MIGRATED_BRANDED_PATHS`.
    const families = [
      { routes: feishuConnectRoutes, suffix: "integrations/feishu" },
      { routes: slackConnectRoutes, suffix: "integrations/slack/connect" },
      { routes: strapiIntegrationsRoutes, suffix: "integrations/strapi" },
    ];

    for (const { routes, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`);
        return response.status;
      }

      const neutral = await statusFor(`/api/${suffix}`);
      const okou = await statusFor(`/api/okou/${suffix}`);
      const zero = await statusFor(`/api/zero/${suffix}`);

      expect({ suffix, neutral, okou, zero }).toStrictEqual({
        suffix,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });

  // The #28463 twin of the two assertions above, and the one that covers a GET
  // as well as a POST: the slice moved a mix of methods, and a row is matched on
  // `entry.route.path` alone. Every branded path below exists only because of
  // a table row, and the request goes through the app factory production wires,
  // so a row that never reaches the registration chain fails here rather than
  // 404ing a released CLI or platform build.
  it("serves the migrated product paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const endpoints = [
      {
        routes: uploadsPrepareRoutes,
        method: "POST",
        suffix: "uploads/prepare",
      },
      { routes: voiceIoQuotaRoutes, method: "GET", suffix: "voice-io/quota" },
    ] as const;

    for (const { routes, method, suffix } of endpoints) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(
          `${REQUEST_ORIGIN}${path}`,
          method === "GET"
            ? { method }
            : {
                method,
                headers: { "content-type": "application/json" },
                body: "{}",
              },
        );
        return response.status;
      }

      const neutral = await statusFor(`/api/${suffix}`);
      const okou = await statusFor(`/api/okou/${suffix}`);
      const zero = await statusFor(`/api/zero/${suffix}`);

      expect({ suffix, neutral, okou, zero }).toStrictEqual({
        suffix,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });

  // Hono keeps both registrations for a duplicated path and answers with the
  // first, so a colliding row would take a handler over instead of failing.
  // The synthetic case above proves the error is raised; this one runs the real
  // route table through the composition production registers, so the slice that
  // adds a colliding row fails here rather than in production. Asserted over
  // the route table rather than inside `createAppWithRoutes`, because test apps
  // deliberately compose overlapping route slices and would fail an app-wide
  // assertion for reasons that have nothing to do with the table.
  it("keeps the production route table free of colliding registrations", () => {
    expect(() => {
      assertUniqueRouteRegistrations(
        withMigratedBrandedPaths(withApiNamespaceAliases(ROUTES)),
      );
    }).not.toThrow();
  });

  // A count, restated here as a literal, over the inventory above. The
  // per-family cases prove that every row the inventory lists is served on both
  // branded forms; this proves the inventory itself is complete, so a later
  // change that removes a still-needed row fails a test instead of passing
  // because nothing enumerated it.
  //
  // That is the guard #28709 left behind when it took the table from 314 rows
  // to 184, #28711 kept when it took the 42 drained rows that left 142, and
  // #28916 kept when it took the 26 cut-over rows that left 116. None of them
  // left a case asserting the removed rows now 404: `docs/fallback.md`
  // section 1 rules that class out, and the route table already proves the
  // registration is gone. What needs a test is the opposite direction — a row
  // disappearing without the request-log evidence #26701 requires — which is
  // what this count and the per-family cases catch.
  //
  // `MIGRATED_ROUTE_PATHS` carries every row but the two the maps and weather
  // cases own, which is why the total below is two higher than its size. Raise
  // both numbers only with that evidence; an unexplained edit here is the
  // failure this is for.
  it("holds the branded rows this suite has evidence for and no others", () => {
    const MIGRATED_ROWS_WITH_OWN_CASE = 2;
    const MIGRATED_BRANDED_ROW_COUNT = 116;

    expect(
      Object.keys(MIGRATED_ROUTE_PATHS).length + MIGRATED_ROWS_WITH_OWN_CASE,
    ).toBe(MIGRATED_BRANDED_ROW_COUNT);

    // The rows the maps and weather cases own, named rather than counted, so
    // the arithmetic above cannot be satisfied by the wrong two rows.
    for (const owned of ["/api/maps/geocode", "/api/weather/current"]) {
      expect(MIGRATED_ROUTE_PATHS).not.toHaveProperty(owned);
    }
  });

  // The route-table assertion above rebuilds the composition itself, so it
  // cannot see how `createAppWithRoutes` wires it. This one goes through the
  // app factory production uses: if `withMigratedBrandedPaths` were dropped
  // from or reordered in that chain, the branded weather paths would 404 here
  // while the table assertion still passed. Requests are unauthenticated, so
  // the status is whatever the auth layer returns — the point is that all
  // three forms reach the same handler instead of falling through to 404.
  it("serves the migrated weather paths through the production app factory", async () => {
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: weatherRoutes,
    });

    async function statusFor(path: string): Promise<number> {
      const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.status;
    }

    for (const operation of WEATHER_OPERATIONS) {
      const neutral = await statusFor(`/api/weather/${operation}`);
      const okou = await statusFor(`/api/okou/weather/${operation}`);
      const zero = await statusFor(`/api/zero/weather/${operation}`);

      expect({ operation, neutral, okou, zero }).toStrictEqual({
        operation,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });

  // The #28457 twin of the two assertions above, for the billing slice. Every
  // caller of these routes in this repository derives its URL from the
  // contract, so a request-level case is the only place a dropped row shows
  // up as the 404 a released client would get. Requests are unauthenticated,
  // so the status is whatever the auth layer returns — the point is that all
  // three forms reach the same handler instead of falling through to 404.
  it("serves the migrated billing paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      { routes: billingStatusRoutes, method: "GET", suffix: "billing/status" },
    ] as const;

    for (const { routes, method, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
          method,
          headers: { "content-type": "application/json" },
        });
        return response.status;
      }

      const neutral = await statusFor(`/api/${suffix}`);
      const okou = await statusFor(`/api/okou/${suffix}`);
      const zero = await statusFor(`/api/zero/${suffix}`);

      expect({ suffix, neutral, okou, zero }).toStrictEqual({
        suffix,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });

  // The #28464 twin of the two assertions above, driven through the app factory
  // production uses rather than over the route table. Every path is a GET a
  // released web build, or a connect link already sitting in a Slack, Teams, or
  // Feishu message, still asks for. The status is whatever the handler returns
  // without credentials or provider configuration; the point is that all three
  // forms reach the same handler instead of falling through to 404.
  it("serves the migrated IM connect paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      { routes: slackChannelsRoutes, suffix: "slack/channels" },
      { routes: slackOauthRoutes, suffix: "slack/oauth/connect" },
      { routes: slackOauthRoutes, suffix: "slack/oauth/install" },
    ];

    for (const { routes, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
          method: "GET",
        });
        return response.status;
      }

      const neutral = await statusFor(`/api/${suffix}`);
      const okou = await statusFor(`/api/okou/${suffix}`);
      const zero = await statusFor(`/api/zero/${suffix}`);

      expect({ suffix, neutral, okou, zero }).toStrictEqual({
        suffix,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });

  // The #28462 twin, driven through the same production app factory. An
  // installed desktop build hardcodes `/api/okou/org` and
  // `/api/okou/feature-switches` rather than deriving them from a contract, and
  // it has no expiry window, so these are the two rows a dropped registration
  // would strand longest. Requests are unauthenticated, so the status is
  // whatever the auth layer returns — the point is that all three forms reach
  // the same handler instead of falling through to 404.
  it("serves the migrated org and feature-switch paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      { routes: orgReadRoutes, suffix: "org" },
      { routes: featureSwitchesRoutes, suffix: "feature-switches" },
    ];

    for (const { routes, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
          method: "GET",
        });
        return response.status;
      }

      const neutral = await statusFor(`/api/${suffix}`);
      const okou = await statusFor(`/api/okou/${suffix}`);
      const zero = await statusFor(`/api/zero/${suffix}`);

      expect({ suffix, neutral, okou, zero }).toStrictEqual({
        suffix,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });

  // The #28545 twin, and the one slice where the branded forms are held by a
  // provider console rather than by a released client: the Microsoft app
  // registration still lists both callback URLs and Azure Bot can still be
  // pointed at either bot URL, so a dropped row 404s Microsoft itself with no
  // drain window to wait out. Requests carry no credentials, so the status is
  // whatever the handler returns before it has any — the point is that the
  // neutral path and both branded forms reach the same handler.
  it("serves the migrated Teams console paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      {
        routes: teamsOauthRoutes,
        method: "GET",
        neutralSuffix: "integrations/teams/oauth/callback",
        brandedSuffix: "teams/oauth/callback",
      },
      {
        routes: teamsBotRoutes,
        method: "POST",
        neutralSuffix: "webhooks/teams/bot",
        brandedSuffix: "teams/bot",
      },
    ] as const;

    for (const { routes, method, neutralSuffix, brandedSuffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        return response.status;
      }

      const neutral = await statusFor(`/api/${neutralSuffix}`);
      const okou = await statusFor(`/api/okou/${brandedSuffix}`);
      const zero = await statusFor(`/api/zero/${brandedSuffix}`);

      expect({ neutralSuffix, neutral, okou, zero }).toStrictEqual({
        neutralSuffix,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });

  // The synthetic routes are not in the production `MIGRATED_BRANDED_PATHS`, so
  // this app registers only what the two contracts declare and what the
  // expansion derives from them. Since #28701 that no longer includes the
  // legacy form of the branded contract, which is why the last status is a 404
  // rather than the third 200 this test asserted while the fallback existed.
  it("builds an app that serves every path it registers", async () => {
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: [NEUTRAL_ROUTE, BRANDED_ROUTE],
    });

    const paths = [
      "/api/synthetic/thing",
      "/api/okou/synthetic/thing",
      "/api/zero/synthetic/thing",
    ];
    const statuses: number[] = [];
    for (const path of paths) {
      const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      statuses.push(response.status);
    }

    expect(statuses).toStrictEqual([200, 200, 404]);
  });
});
