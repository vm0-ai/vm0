import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../app-factory";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  OPENAI_PRESENTATION_GENERATION_URL,
  PRESENTATION_IO_MODEL,
  type PresentationPricing,
} from "../../services/zero-presentation-io-generate.service";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const TEST_BUCKET = "test-user-storages";
const PRESENTATION_PRICING_CATEGORIES = [
  "tokens.input",
  "tokens.output",
] as const;

type PresentationPricingCategory =
  (typeof PRESENTATION_PRICING_CATEGORIES)[number];

interface PresentationFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly insertedPricingCategories: readonly PresentationPricingCategory[];
}

interface PricingSnapshot {
  readonly category: PresentationPricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface PresentationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly "file:write"[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: args.capabilities ?? ["file:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

function isPresentationPricingCategory(
  value: string,
): value is PresentationPricingCategory {
  return PRESENTATION_PRICING_CATEGORIES.some((category) => {
    return category === value;
  });
}

function expectedCredits(
  usage: PresentationUsage,
  pricing: PresentationPricing,
): number {
  const rows: readonly (readonly [PresentationPricingCategory, number])[] = [
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

async function ensurePresentationPricing(): Promise<{
  readonly pricing: PresentationPricing;
  readonly insertedCategories: readonly PresentationPricingCategory[];
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
        eq(usagePricing.kind, "model"),
        eq(usagePricing.provider, PRESENTATION_IO_MODEL),
        inArray(usagePricing.category, [...PRESENTATION_PRICING_CATEGORIES]),
      ),
    );

  const pricing = new Map<PresentationPricingCategory, PricingSnapshot>();
  for (const row of rows) {
    if (isPresentationPricingCategory(row.category)) {
      pricing.set(row.category, {
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }

  const defaults: Readonly<
    Record<PresentationPricingCategory, PricingSnapshot>
  > = {
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

  const insertedCategories: PresentationPricingCategory[] = [];
  for (const category of PRESENTATION_PRICING_CATEGORIES) {
    if (!pricing.has(category)) {
      const row = defaults[category];
      await writeDb.insert(usagePricing).values({
        kind: "model",
        provider: PRESENTATION_IO_MODEL,
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

async function deletePresentationPricingRows(): Promise<
  readonly PricingSnapshot[]
> {
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
        eq(usagePricing.kind, "model"),
        eq(usagePricing.provider, PRESENTATION_IO_MODEL),
        inArray(usagePricing.category, [...PRESENTATION_PRICING_CATEGORIES]),
      ),
    );

  await writeDb
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "model"),
        eq(usagePricing.provider, PRESENTATION_IO_MODEL),
        inArray(usagePricing.category, [...PRESENTATION_PRICING_CATEGORIES]),
      ),
    );

  return rows.filter((row): row is PricingSnapshot => {
    return isPresentationPricingCategory(row.category);
  });
}

async function restorePresentationPricingRows(
  rows: readonly PricingSnapshot[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await store
    .set(writeDb$)
    .insert(usagePricing)
    .values(
      rows.map((row) => {
        return {
          kind: "model",
          provider: PRESENTATION_IO_MODEL,
          category: row.category,
          unitPrice: row.unitPrice,
          unitSize: row.unitSize,
        };
      }),
    );
}

async function seedPresentationFixture(options: {
  readonly credits?: number;
  readonly withPricing?: boolean;
}): Promise<PresentationFixture> {
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
    credits: options.credits ?? 10_000,
  });
  await writeDb.insert(orgMembersMetadata).values({
    orgId,
    userId,
    creditEnabled: true,
  });

  const pricing = options.withPricing
    ? await ensurePresentationPricing()
    : { insertedCategories: [] };

  return {
    orgId,
    userId,
    insertedPricingCategories: pricing.insertedCategories,
  };
}

async function deletePresentationFixture(
  fixture: PresentationFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.orgId, fixture.orgId),
        eq(runUploadedFiles.userId, fixture.userId),
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
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
  if (fixture.insertedPricingCategories.length > 0) {
    await writeDb
      .delete(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, PRESENTATION_IO_MODEL),
          inArray(usagePricing.category, [
            ...fixture.insertedPricingCategories,
          ]),
        ),
      );
  }
}

function presentationDeckJson(): string {
  return JSON.stringify({
    title: "API Migration Plan",
    subtitle: "Reducing integration risk while moving clients forward",
    slides: [
      {
        layout: "cover",
        kicker: "Migration",
        title: "API Migration Plan",
        body: "A practical path to move clients without disrupting live traffic.",
        bullets: [],
        metric: "",
        note: "",
      },
      {
        layout: "bullets",
        kicker: "Risk",
        title: "Where migrations fail",
        body: "Most failures happen at contract edges and rollout timing.",
        bullets: [
          "Inventory active clients",
          "Find schema drift",
          "Stage compatibility windows",
        ],
        metric: "3 control points",
        note: "",
      },
      {
        layout: "two_column",
        kicker: "Plan",
        title: "Rollout model",
        body: "Ship adapters first, then move traffic by cohort.",
        bullets: [
          "Internal traffic",
          "Low-risk customers",
          "High-volume accounts",
        ],
        metric: "",
        note: "",
      },
      {
        layout: "closing",
        kicker: "Next",
        title: "Decision path",
        body: "Approve adapter work and schedule the first cohort.",
        bullets: [
          "Lock target contract",
          "Publish migration guide",
          "Review metrics weekly",
        ],
        metric: "",
        note: "Generated test deck.",
      },
    ],
  });
}

describe("POST /api/zero/presentation-io/generate", () => {
  const track = createFixtureTracker<PresentationFixture>(
    deletePresentationFixture,
  );
  const trackPricing = createFixtureTracker<readonly PricingSnapshot[]>(
    restorePresentationPricingRows,
  );

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
  });

  it("returns 401 when not authenticated", async () => {
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/presentation-io/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: "a deck" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 503 when presentation pricing is not configured", async () => {
    const fixture = await track(seedPresentationFixture({ credits: 1000 }));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await trackPricing(deletePresentationPricingRows());
    let calledOpenAi = false;
    server.use(
      http.post(OPENAI_PRESENTATION_GENERATION_URL, () => {
        calledOpenAi = true;
        return HttpResponse.json({});
      }),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/presentation-io/generate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt: "a deck" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Presentation generation pricing is not configured",
        code: "NOT_CONFIGURED",
      },
    });
    expect(calledOpenAi).toBeFalsy();
  });

  it("generates HTML presentation files for run-scoped zero tokens", async () => {
    const fixture = await track(seedPresentationFixture({ withPricing: true }));
    const { pricing } = await ensurePresentationPricing();
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
      },
      context.signal,
    );
    const usage: PresentationUsage = {
      inputTokens: 1800,
      outputTokens: 620,
      totalTokens: 2420,
    };
    const creditsCharged = expectedCredits(usage, pricing);
    let observedAuthorization: string | null = null;
    let observedBody: unknown = null;
    server.use(
      http.post(OPENAI_PRESENTATION_GENERATION_URL, async ({ request }) => {
        observedAuthorization = request.headers.get("authorization");
        observedBody = await request.json();
        return HttpResponse.json({
          id: "resp_presentation_test",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: presentationDeckJson(),
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

    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
    });
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/zero/presentation-io/generate", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: "API migration plan",
        style: "swiss",
        slideCount: 4,
        theme: "ikb",
        audience: "engineering leadership",
        title: "API Migration Plan",
      }),
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      contentType: "text/html",
      creditsCharged,
      model: PRESENTATION_IO_MODEL,
      style: "swiss",
      theme: "ikb",
      slideCount: 4,
      title: "API Migration Plan",
      responseId: "resp_presentation_test",
      usage,
    });
    expect(observedAuthorization).toBe("Bearer test-openai-key");
    expect(observedBody).toMatchObject({
      model: PRESENTATION_IO_MODEL,
      input: expect.stringContaining("API migration plan"),
      reasoning: { effort: "medium" },
      text: {
        verbosity: "medium",
        format: expect.objectContaining({
          type: "json_schema",
          name: "presentation_deck",
          strict: true,
        }),
      },
    });

    if (
      !(
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        "filename" in body &&
        "url" in body &&
        "size" in body
      )
    ) {
      throw new Error("Expected presentation response id, filename, url, size");
    }
    const fileId = String(body.id);
    const filename = String(body.filename);
    const url = String(body.url);
    expect(filename).toBe(`presentation-${fileId.slice(0, 8)}.html`);
    expect(url).toBe(
      `http://localhost:3000/f/${encodeURIComponent(
        fixture.userId.replace(/^user_/, ""),
      )}/${fileId}/${filename}`,
    );

    const putInput = commandInput(context.mocks.s3.send.mock.calls[0]?.[0]);
    expect(putInput.Bucket).toBe(TEST_BUCKET);
    expect(putInput.Key).toBe(
      `uploads/${fixture.userId}/${fileId}/${filename}`,
    );
    expect(putInput.ContentType).toBe("text/html");
    const putBody = putInput.Body;
    expect(Buffer.isBuffer(putBody)).toBeTruthy();
    if (!Buffer.isBuffer(putBody)) {
      throw new Error("Expected S3 put body to be a Buffer");
    }
    const html = putBody.toString("utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>API Migration Plan</title>");
    expect(html).toContain("Presentation controls");
    expect(Number(body.size)).toBe(putBody.byteLength);

    const uploadRows = await store
      .set(writeDb$)
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.externalId, fileId));
    expect(uploadRows).toHaveLength(1);
    expect(uploadRows[0]).toMatchObject({
      runId,
      source: "web",
      externalId: fileId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      filename,
      contentType: "text/html",
      sizeBytes: putBody.byteLength,
      url,
    });
    expect(uploadRows[0]?.metadata).toMatchObject({
      generatedBy: "zero-official-presentation",
      model: PRESENTATION_IO_MODEL,
      style: "swiss",
      theme: "ikb",
      slideCount: 4,
      title: "API Migration Plan",
      responseId: "resp_presentation_test",
      s3Key: `uploads/${fixture.userId}/${fileId}/${filename}`,
    });

    const usageRows = await store
      .set(writeDb$)
      .select()
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, fixture.orgId),
          eq(usageEvent.userId, fixture.userId),
          eq(usageEvent.kind, "model"),
          eq(usageEvent.provider, PRESENTATION_IO_MODEL),
        ),
      );
    expect(usageRows).toHaveLength(2);
    expect(usageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId,
          category: "tokens.input",
          quantity: usage.inputTokens,
          status: "processed",
          billingError: null,
        }),
        expect.objectContaining({
          runId,
          category: "tokens.output",
          quantity: usage.outputTokens,
          status: "processed",
          billingError: null,
        }),
      ]),
    );
    const totalCredits = usageRows.reduce((total, row) => {
      return total + (row.creditsCharged ?? 0);
    }, 0);
    expect(totalCredits).toBe(creditsCharged);
  });
});
