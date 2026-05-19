import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it, beforeEach } from "vitest";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../app-factory";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  OPENAI_WEBSITE_GENERATION_URL,
  WEBSITE_USAGE_KIND,
  WEBSITE_IO_MODEL,
  type WebsitePricing,
} from "../../services/zero-website-io-generate.service";
import { builtInGenerationUsageIdempotencyKey } from "../../services/built-in-generation-usage-idempotency";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const WEBSITE_PRICING_CATEGORIES = ["tokens.input", "tokens.output"] as const;

type WebsitePricingCategory = (typeof WEBSITE_PRICING_CATEGORIES)[number];

interface WebsiteFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly insertedPricingCategories: readonly WebsitePricingCategory[];
}

interface PricingSnapshot {
  readonly category: WebsitePricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface WebsiteUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function isWebsitePricingCategory(
  value: string,
): value is WebsitePricingCategory {
  return WEBSITE_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

function expectedCredits(usage: WebsiteUsage, pricing: WebsitePricing): number {
  const rows: readonly (readonly [WebsitePricingCategory, number])[] = [
    ["tokens.input", usage.inputTokens],
    ["tokens.output", usage.outputTokens],
  ];

  return rows.reduce((total, [category, quantity]) => {
    if (quantity <= 0) {
      return total;
    }
    const row = pricing.get(category);
    if (!row) {
      return total;
    }
    return total + Math.ceil((quantity * row.unitPrice) / row.unitSize);
  }, 0);
}

async function ensureWebsitePricing(): Promise<{
  readonly pricing: WebsitePricing;
  readonly insertedCategories: readonly WebsitePricingCategory[];
}> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, WEBSITE_USAGE_KIND),
        eq(usagePricing.provider, WEBSITE_IO_MODEL),
        inArray(usagePricing.category, [...WEBSITE_PRICING_CATEGORIES]),
      ),
    );

  const pricing = new Map<WebsitePricingCategory, PricingSnapshot>();
  for (const row of rows) {
    if (isWebsitePricingCategory(row.category)) {
      pricing.set(row.category, {
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }

  const defaults: Readonly<Record<WebsitePricingCategory, PricingSnapshot>> = {
    "tokens.input": {
      category: "tokens.input",
      unitPrice: 5000,
      unitSize: 1_000_000,
    },
    "tokens.output": {
      category: "tokens.output",
      unitPrice: 30_000,
      unitSize: 1_000_000,
    },
  };

  const insertedCategories: WebsitePricingCategory[] = [];
  for (const category of WEBSITE_PRICING_CATEGORIES) {
    if (!pricing.has(category)) {
      const row = defaults[category];
      await writeDb.insert(usagePricing).values({
        kind: WEBSITE_USAGE_KIND,
        provider: WEBSITE_IO_MODEL,
        category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
      pricing.set(category, row);
      insertedCategories.push(category);
    }
  }

  return { pricing, insertedCategories };
}

async function seedWebsiteFixture(): Promise<WebsiteFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);

  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  await writeDb.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });
  await writeDb.insert(orgMembersMetadata).values({
    orgId,
    userId,
    creditEnabled: true,
  });
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [FeatureSwitchKey.HostedSites]: true },
  });

  const pricing = await ensureWebsitePricing();
  return {
    orgId,
    userId,
    insertedPricingCategories: pricing.insertedCategories,
  };
}

async function deleteWebsiteFixture(fixture: WebsiteFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(usageEvent).where(eq(usageEvent.orgId, fixture.orgId));
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
  if (fixture.insertedPricingCategories.length > 0) {
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, WEBSITE_USAGE_KIND),
          eq(usagePricing.provider, WEBSITE_IO_MODEL),
          inArray(usagePricing.category, [
            ...fixture.insertedPricingCategories,
          ]),
        ),
      );
  }
}

function websitePayloadJson(): string {
  return JSON.stringify({
    templateId: "launch",
    siteData: {
      siteName: "Clearpath Observability",
      eyebrow: "Developer operations",
      headline: "Find production issues before customers do",
      subhead:
        "A focused observability workspace for small teams that need fast traces, useful alerts, and calmer on-call rotations.",
      primaryCta: { label: "Start monitoring", href: "#contact" },
      secondaryCta: { label: "See features", href: "#features" },
      highlights: [
        {
          title: "Trace-first debugging",
          body: "Move from alert to exact request path without hunting through dashboards.",
        },
        {
          title: "Compact incident rooms",
          body: "Keep logs, owners, deploys, and decisions in one working view.",
        },
        {
          title: "Human-scale alerts",
          body: "Tune noise down with service-aware thresholds and simple routing.",
        },
      ],
      sections: [
        {
          kicker: "Workflow",
          title: "Built for the first hour of an incident",
          body: "The template emphasizes fast diagnosis, clear ownership, and a direct path from signal to action.",
          bullets: [
            "Surface recent deploys",
            "Group related traces",
            "Record decisions",
          ],
        },
        {
          kicker: "Rollout",
          title: "Adopt it service by service",
          body: "Teams can start with one critical path and expand coverage as alert quality improves.",
          bullets: [
            "Start with checkout",
            "Review noise weekly",
            "Share runbooks",
          ],
        },
      ],
      stats: [
        { value: "15 min", label: "target setup time" },
        { value: "3 views", label: "alert, trace, decision" },
      ],
      footer: {
        title: "Ready for a calmer on-call loop",
        body: "Publish the first service dashboard and use it in the next incident review.",
        cta: { label: "Book a walkthrough", href: "#top" },
      },
      theme: { accent: "cobalt", tone: "light" },
    },
  });
}

describe("POST /api/zero/website-io/generate", () => {
  const track = createFixtureTracker<WebsiteFixture>(deleteWebsiteFixture);

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  it("returns 401 when not authenticated", async () => {
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a website" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when prompt is missing", async () => {
    const fixture = await track(seedWebsiteFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ template: "launch" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "prompt is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 403 when hosted sites are disabled", async () => {
    mocks.clerk.session(
      "user_hosted_sites_disabled",
      "org_hosted_sites_disabled",
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "A website" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Hosted sites are not enabled", code: "FORBIDDEN" },
    });
  });

  it("generates template content and charges model usage", async () => {
    const fixture = await track(seedWebsiteFixture());
    const { pricing } = await ensureWebsitePricing();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const usage: WebsiteUsage = {
      inputTokens: 1200,
      outputTokens: 480,
      totalTokens: 1680,
    };
    const creditsCharged = expectedCredits(usage, pricing);
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(OPENAI_WEBSITE_GENERATION_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          id: "resp_website_test",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: websitePayloadJson(),
                },
              ],
            },
          ],
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          },
        });
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/website-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        prompt: "A launch site for an observability product",
        template: "launch",
        title: "Clearpath Observability",
        audience: "small engineering teams",
      }),
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      templateId: "launch",
      templateLabel: "Launch site",
      slugSuggestion: "clearpath-observability",
      creditsCharged,
      model: WEBSITE_IO_MODEL,
      responseId: "resp_website_test",
      usage,
      siteData: {
        siteName: "Clearpath Observability",
        headline: "Find production issues before customers do",
      },
    });
    expect(observedAuthorization).toBe("Bearer test-openai-key");
    expect(observedBody).toMatchObject({
      model: WEBSITE_IO_MODEL,
      input: expect.stringContaining(
        "A launch site for an observability product",
      ),
      reasoning: { effort: "medium" },
      text: {
        verbosity: "medium",
        format: expect.objectContaining({
          type: "json_schema",
          name: "website_template_content",
          strict: true,
        }),
      },
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "generationId" in body &&
        typeof body.generationId === "string"
      )
    ) {
      throw new Error("Expected website response generationId");
    }

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, WEBSITE_USAGE_KIND),
          eq(usageEvent.provider, WEBSITE_IO_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(2);
    expect(usageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId: body.generationId,
            scope: "website-content",
            category: "tokens.input",
          }),
          category: "tokens.input",
          quantity: usage.inputTokens,
          status: "processed",
          billingError: null,
        }),
        expect.objectContaining({
          idempotencyKey: builtInGenerationUsageIdempotencyKey({
            generationId: body.generationId,
            scope: "website-content",
            category: "tokens.output",
          }),
          category: "tokens.output",
          quantity: usage.outputTokens,
          status: "processed",
          billingError: null,
        }),
      ]),
    );
  });
});
