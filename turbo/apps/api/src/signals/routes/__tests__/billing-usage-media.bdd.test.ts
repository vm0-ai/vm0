// helper gap:
// - Paid media completion needs org credits plus usage pricing. No public API
//   helper in this BDD slice can grant credits or seed pricing, so these tests
//   cover the visible no-credit/provider-boundary responses and read APIs.
// - Billing settlement needs Stripe webhooks or checkout completion that grants
//   entitlements. This file asserts the route-visible checkout, portal, invoice,
//   redeem, status, and usage surfaces without direct database fixtures.
// - Banking success needs a current zero run, banking connection, account grant,
//   and provider account state. This file covers the public credential gate and
//   records the success-chain gap instead of seeding banking tables.

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";

const context = testContext();
const appUrl = "http://localhost:3002";

function testActors() {
  const base = createBddApi(context);
  const api = createBillingMediaApi(context);
  const admin = base.user();
  const member = base.user({ orgId: admin.orgId, orgRole: "org:member" });
  base.acceptAgentStorageWrites();
  return { api, admin, member };
}

async function completeVisibleOnboarding(
  api: ReturnType<typeof createBillingMediaApi>,
  admin: ApiTestUser,
): Promise<void> {
  await api.setupOnboarding(admin, {
    displayName: "BDD Billing Media Agent",
    sound: "calm",
  });
}

function checkoutUrls() {
  return {
    successUrl: `${appUrl}/settings/billing/success`,
    cancelUrl: `${appUrl}/settings/billing/cancel`,
  };
}

function pcmFormData(): FormData {
  const formData = new FormData();
  formData.append(
    "file",
    new File([new Uint8Array([0, 0])], "audio.wav", {
      type: "audio/wav",
    }),
  );
  return formData;
}

describe("BILL-01: billing status and Stripe-backed actions through public API", () => {
  it("chains status, checkout, portal, invoices, redeem, and admin errors without hidden DB state", async () => {
    const { api, admin, member } = testActors();
    await completeVisibleOnboarding(api, admin);

    const initialStatus = await api.readBillingStatus(admin);
    expect(initialStatus).toMatchObject({
      tier: "pro-suspend",
      credits: 0,
      hasSubscription: false,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    const initialRecharge = await api.readAutoRecharge(admin);
    expect(initialRecharge).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });

    const invalidRecharge = await api.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 1000 },
      [400],
    );
    expectApiError(invalidRecharge.body);
    expect(invalidRecharge.body.error.code).toBe("BAD_REQUEST");

    const disabledRecharge = await api.updateAutoRecharge(
      admin,
      { enabled: false },
      [200],
    );
    expect(disabledRecharge.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });

    api.configureBillingPrices();
    const stripeIdSuffix = admin.userId.replaceAll("-", "");
    const stripeCustomerId = `cus_${stripeIdSuffix}`;
    const subscriptionSessionId = `cs_sub_${stripeIdSuffix}`;
    const creditsSessionId = `cs_credits_${stripeIdSuffix}`;
    const campaignSessionId = `cs_campaign_${stripeIdSuffix}`;
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: stripeCustomerId,
    });
    context.mocks.stripe.checkout.sessions.create
      .mockResolvedValueOnce({
        id: subscriptionSessionId,
        url: "https://checkout.stripe.test/subscription",
      })
      .mockResolvedValueOnce({
        id: creditsSessionId,
        url: "https://checkout.stripe.test/credits",
      })
      .mockResolvedValueOnce({
        id: campaignSessionId,
        url: "https://checkout.stripe.test/campaign",
      });

    const memberCheckout = await api.requestCheckout(
      member,
      { tier: "pro", ...checkoutUrls() },
      [403],
    );
    expectApiError(memberCheckout.body);
    expect(memberCheckout.body.error.message).toBe(
      "Only org admins can manage billing",
    );

    const checkout = await api.startCheckout(admin, {
      tier: "pro",
      ...checkoutUrls(),
    });
    expect(checkout.body).toStrictEqual({
      url: "https://checkout.stripe.test/subscription",
    });

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: subscriptionSessionId,
      customer: "cus_other",
      status: "complete",
      mode: "subscription",
      subscription: "sub_other",
    });
    const mismatch = await api.completeCheckout(
      admin,
      { sessionId: subscriptionSessionId },
      [400],
    );
    expectApiError(mismatch.body);

    context.mocks.stripe.prices.retrieve.mockResolvedValue({
      id: "price_bdd_custom",
      product: "prod_bdd_custom",
      currency: "usd",
      custom_unit_amount: { minimum: null, maximum: null },
    });
    context.mocks.stripe.prices.create.mockResolvedValue({
      id: "price_bdd_credit_preset",
    });
    const creditCheckout = await api.startCreditCheckout(admin, {
      credits: 2000,
      ...checkoutUrls(),
    });
    expect(creditCheckout.body).toStrictEqual({
      url: "https://checkout.stripe.test/credits",
    });

    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.test/session",
    });
    const portal = await api.openPortal(admin, {
      returnUrl: `${appUrl}/settings/billing`,
    });
    expect(portal.body).toStrictEqual({
      url: "https://billing.stripe.test/session",
    });

    context.mocks.stripe.invoices.list.mockResolvedValue({
      data: [
        {
          id: "in_bdd",
          number: "INV-BDD",
          created: 1_700_000_000,
          amount_paid: 2500,
          status: "paid",
          hosted_invoice_url: "https://billing.stripe.test/invoices/in_bdd",
        },
      ],
    });
    const invoices = await api.readInvoices(admin);
    expect(invoices.invoices).toStrictEqual([
      {
        id: "in_bdd",
        number: "INV-BDD",
        date: 1_700_000_000,
        amount: 2500,
        status: "paid",
        hostedInvoiceUrl: "https://billing.stripe.test/invoices/in_bdd",
      },
    ]);

    const memberInvoices = await api.requestInvoices(member, [403]);
    expectApiError(memberInvoices.body);
    expect(memberInvoices.body.error.message).toBe(
      "Only org admins can view invoices",
    );

    const downgrade = await api.downgradeBilling(
      admin,
      { targetTier: "pro-suspend", returnUrl: `${appUrl}/settings/billing` },
      [409],
    );
    expectApiError(downgrade.body);
    expect(downgrade.body.error.message).toBe("Org has no active subscription");

    const restore = await api.restoreBilling(
      admin,
      { returnUrl: `${appUrl}/settings/billing` },
      [409],
    );
    expectApiError(restore.body);
    expect(restore.body.error.message).toBe("Org has no active subscription");

    const missingCampaign = await api.redeemCampaign(
      admin,
      "UNKNOWN",
      checkoutUrls(),
    );
    expect(missingCampaign.body).toStrictEqual({
      status: "error",
      reason: "campaign_misconfigured",
    });

    api.configureCampaign();
    const readyCampaign = await api.redeemCampaign(
      admin,
      "ZERO100",
      checkoutUrls(),
    );
    expect(readyCampaign.body).toStrictEqual({
      status: "ready",
      checkoutUrl: "https://checkout.stripe.test/campaign",
    });

    context.mocks.clerk.m2m.createToken.mockResolvedValue({
      token: "m2m_bdd_token",
    });
    server.use(
      http.post("https://atom.example.test/api/redeem-codes/consume", () => {
        return HttpResponse.json({ code: "invalid" }, { status: 404 });
      }),
    );
    const invalidCode = await api.redeemCode(
      admin,
      { code: "BAD-CODE" },
      [400],
    );
    expectApiError(invalidCode.body);
    expect(invalidCode.body.error.message).toBe("Invalid redeem code");

    const finalStatus = await api.readBillingStatus(admin);
    expect(finalStatus.credits).toBe(0);
    expect(finalStatus.hasSubscription).toBeFalsy();
  });
});

describe("BILL-02: usage, insights, attribution, model stats, and usage cron reads", () => {
  it("chains empty scoped usage reads and cron aggregation through visible APIs", async () => {
    const { api, admin, member } = testActors();
    await completeVisibleOnboarding(api, admin);

    const personalUsage = await api.readUsage(admin);
    expect(personalUsage.body.summary).toStrictEqual({
      total_runs: 0,
      total_run_time_ms: 0,
    });

    const usageMembers = await api.readUsageMembers(admin);
    expect(usageMembers.body.members).toStrictEqual([]);

    const usageRuns = await api.readUsageRuns(admin, [200]);
    if (usageRuns.status !== 200) {
      throw new Error(
        `Expected usage runs to be readable, got ${usageRuns.status}`,
      );
    }
    expect(usageRuns.body.pagination.total).toBe(0);
    expect(usageRuns.body.runs).toStrictEqual([]);

    const memberUsageRuns = await api.readUsageRuns(member, [403]);
    expectApiError(memberUsageRuns.body);
    expect(memberUsageRuns.body.error.message).toBe(
      "Only org admins can view run usage",
    );

    const usageRecord = await api.readUsageRecord(admin);
    expect(usageRecord.body.pagination.total).toBe(0);
    expect(usageRecord.body.rows).toStrictEqual([]);

    const usageInsight = await api.readUsageInsight(
      admin,
      { range: "today", groupBy: "source", tz: "UTC" },
      [200],
    );
    if (usageInsight.status !== 200) {
      throw new Error(
        `Expected usage insight to be readable, got ${usageInsight.status}`,
      );
    }
    expect(usageInsight.body.grandTotalCredits).toBe(0);
    expect(usageInsight.body.grandTotalTokens).toBe(0);

    const invalidInsight = await api.readUsageInsight(
      admin,
      { range: "today", groupBy: "source", tz: "Invalid/Timezone" },
      [400],
    );
    expectApiError(invalidInsight.body);
    expect(invalidInsight.body.error.message).toBe(
      "Invalid timezone: Invalid/Timezone",
    );

    const insights = await api.readInsights(admin);
    expect(insights.totalCredits).toBe(0);
    expect(insights.totalRuns).toBe(0);

    const insightsRange = await api.readInsightsRange(admin);
    expect(insightsRange.totalDays).toBeGreaterThanOrEqual(0);

    const modelRankings = await api.readModelRankings();
    expect(modelRankings.body.period).toBe("week");
    expect(Array.isArray(modelRankings.body.rows)).toBeTruthy();

    const processed = await api.processUsageEvents();
    expect(processed.body.success).toBeTruthy();
    expect(processed.body.processed).toBeGreaterThanOrEqual(0);

    const aggregatedUsage = await api.aggregateUsage();
    expect(aggregatedUsage.body.aggregated).toBeGreaterThanOrEqual(0);

    const aggregatedInsights = await api.aggregateInsights();
    expect(aggregatedInsights.body.users).toBeGreaterThanOrEqual(0);

    context.mocks.clerk.users.updateUser.mockResolvedValue({});
    const attribution = await api.recordSignupAttribution(admin);
    expect(attribution.body).toStrictEqual({ recorded: true });
    expect(context.mocks.clerk.users.updateUser).toHaveBeenCalledWith(
      admin.userId,
      expect.objectContaining({
        privateMetadata: expect.objectContaining({
          signup_attribution: expect.objectContaining({
            source_type: "paid",
            utm_source: "bdd",
          }),
        }),
      }),
    );
  });
});

describe("FILE-02 and CHAIN-BILLING-MEDIA: media generation, quota, and status APIs", () => {
  it("chains media quota, generation gates, TTS, and status reads through API-visible state", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(api, admin);

    const quota = await api.readVoiceQuota(admin);
    expect(quota.body).toStrictEqual({ allowed: false, count: 0, limit: 0 });

    const stt = await api.requestVoiceStt(admin, pcmFormData(), [402]);
    expectApiError(stt.body);
    expect(stt.body.error.code).toBe("AUDIO_INPUT_QUOTA_EXCEEDED");

    const audioV1 = await api.requestAudioTranscriptionV1(admin, [403]);
    expectApiError(audioV1.body);
    expect(audioV1.body.error.message).toBe(
      "This endpoint does not accept the provided credential type",
    );

    const authApi = createAuthOrgAgentsBddApi(context);
    const apiKey = await authApi.createApiKey(admin, {
      name: "BDD audio v1",
      expiresInDays: 1,
    });

    const unsupportedAudio = await api.requestAudioTranscriptionV1WithBearer(
      apiKey.token,
      new Blob([new Uint8Array([0, 0])], { type: "text/plain" }),
      [400],
    );
    expectApiError(unsupportedAudio.body);
    expect(unsupportedAudio.body.error.message).toBe(
      "Unsupported audio format. Send raw 16 kHz mono signed 16-bit PCM as application/octet-stream.",
    );

    const rateLimitedAudio = await api.requestAudioTranscriptionV1WithBearer(
      apiKey.token,
      new Blob([new Uint8Array([0, 0])], {
        type: "application/octet-stream",
      }),
      [429],
    );
    expectApiError(rateLimitedAudio.body);
    expect(rateLimitedAudio.body.error.code).toBe("DAILY_RATE_LIMIT_EXCEEDED");

    const unauthenticatedTts = await api.requestVoiceTts(
      null,
      { text: "hello" },
      [401],
    );
    expectApiError(unauthenticatedTts.body);
    expect(unauthenticatedTts.body.error.code).toBe("UNAUTHORIZED");

    await api.updateFeatureSwitches(admin, {
      [FeatureSwitchKey.AudioOutput]: true,
    });
    server.use(
      http.post("https://api.openai.com/v1/audio/speech", () => {
        return new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }),
    );
    const tts = await api.requestVoiceTts(admin, { text: "hello" }, [200]);
    expect(tts.body).toBeInstanceOf(Blob);

    const speech = await api.requestVoiceSpeech(
      admin,
      { text: "hello", voice: "marin" },
      [402],
    );
    expectApiError(speech.body);
    expect(speech.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const invalidSpeechVoice = await api.requestVoiceSpeech(
      admin,
      { text: "hello", voice: "not-a-voice" },
      [400],
    );
    expectApiError(invalidSpeechVoice.body);
    expect(invalidSpeechVoice.body.error.message).toBe(
      "Unsupported voice: not-a-voice",
    );

    const missingSpeechText = await api.requestVoiceSpeech(
      admin,
      { text: "   ", voice: "marin" },
      [400],
    );
    expectApiError(missingSpeechText.body);
    expect(missingSpeechText.body.error.message).toBe("text is required");

    api.configureGemini();
    const invalidGeminiPrompt = await api.requestGenerateImage(
      admin,
      { prompt: "" },
      [400],
    );
    expectApiError(invalidGeminiPrompt.body);
    expect(invalidGeminiPrompt.body.error.message).toBe(
      "prompt is required and must be a non-empty string",
    );

    const generatedImage = await api.requestGenerateImage(
      admin,
      { prompt: "a concise billing usage chart" },
      [402],
    );
    expectApiError(generatedImage.body);
    expect(generatedImage.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const missingImageIoPrompt = await api.requestImageIoGenerate(
      admin,
      {},
      [400],
    );
    expectApiError(missingImageIoPrompt.body);
    expect(missingImageIoPrompt.body.error.message).toBe("prompt is required");

    const unsupportedImageIoModel = await api.requestImageIoGenerate(
      admin,
      { prompt: "a concise billing usage chart", model: "not-a-model" },
      [400],
    );
    expectApiError(unsupportedImageIoModel.body);
    expect(unsupportedImageIoModel.body.error.message).toContain(
      "Unsupported image model: not-a-model",
    );

    const unsupportedImageSize = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        size: "42x42",
      },
      [400],
    );
    expectApiError(unsupportedImageSize.body);
    expect(unsupportedImageSize.body.error.message).toContain(
      "Unsupported image size",
    );

    const unsupportedImageQuality = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        quality: "best",
      },
      [400],
    );
    expectApiError(unsupportedImageQuality.body);
    expect(unsupportedImageQuality.body.error.message).toBe(
      "Unsupported image quality: best",
    );

    const unsupportedImageBackground = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        background: "magic",
      },
      [400],
    );
    expectApiError(unsupportedImageBackground.body);
    expect(unsupportedImageBackground.body.error.message).toBe(
      "Unsupported image background: magic",
    );

    const transparentGptImage2 = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        model: "gpt-image-2",
        background: "transparent",
      },
      [400],
    );
    expectApiError(transparentGptImage2.body);
    expect(transparentGptImage2.body.error.message).toBe(
      "gpt-image-2 does not support transparent backgrounds",
    );

    const unsupportedImageFormat = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        outputFormat: "gif",
      },
      [400],
    );
    expectApiError(unsupportedImageFormat.body);
    expect(unsupportedImageFormat.body.error.message).toBe(
      "Unsupported image output format: gif",
    );

    const unsupportedImageCompression = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        outputFormat: "png",
        outputCompression: 50,
      },
      [400],
    );
    expectApiError(unsupportedImageCompression.body);
    expect(unsupportedImageCompression.body.error.message).toBe(
      "outputCompression is only supported for jpeg or webp output",
    );

    const unsupportedImageModeration = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        moderation: "strict",
      },
      [400],
    );
    expectApiError(unsupportedImageModeration.body);
    expect(unsupportedImageModeration.body.error.message).toBe(
      "Unsupported image moderation: strict",
    );

    const unsupportedImageSeed = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        seed: 1,
      },
      [400],
    );
    expectApiError(unsupportedImageSeed.body);
    expect(unsupportedImageSeed.body.error.message).toBe(
      "seed is not supported for gpt-image-1",
    );

    const unsupportedImageSafetyTolerance = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        safetyTolerance: "6",
      },
      [400],
    );
    expectApiError(unsupportedImageSafetyTolerance.body);
    expect(unsupportedImageSafetyTolerance.body.error.message).toBe(
      "safetyTolerance is not supported for gpt-image-1",
    );

    const unsupportedImageEnhancePrompt = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        enhancePrompt: true,
      },
      [400],
    );
    expectApiError(unsupportedImageEnhancePrompt.body);
    expect(unsupportedImageEnhancePrompt.body.error.message).toBe(
      "enhancePrompt is not supported for gpt-image-1",
    );

    const invalidSourceImages = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        imageUrls: ["https://assets.example.test/source.png", ""],
      },
      [400],
    );
    expectApiError(invalidSourceImages.body);
    expect(invalidSourceImages.body.error.message).toBe(
      "imageUrls must contain non-empty strings",
    );

    const maskWithoutSource = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        maskImageUrl: "https://assets.example.test/mask.png",
      },
      [400],
    );
    expectApiError(maskWithoutSource.body);
    expect(maskWithoutSource.body.error.message).toBe(
      "maskImageUrl requires imageUrl",
    );

    const inputFidelityWithoutSource = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        inputFidelity: "high",
      },
      [400],
    );
    expectApiError(inputFidelityWithoutSource.body);
    expect(inputFidelityWithoutSource.body.error.message).toBe(
      "inputFidelity requires imageUrl",
    );

    const invalidPromptStrength = await api.requestImageIoGenerate(
      admin,
      {
        prompt: "a concise billing usage chart",
        imagePromptStrength: 2,
      },
      [400],
    );
    expectApiError(invalidPromptStrength.body);
    expect(invalidPromptStrength.body.error.message).toBe(
      "imagePromptStrength must be between 0 and 1",
    );

    const imageIo = await api.requestImageIoGenerate(
      admin,
      { prompt: "a concise billing usage chart" },
      [402],
    );
    expectApiError(imageIo.body);
    expect(imageIo.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const missingVideoIoPrompt = await api.requestVideoIoGenerate(
      admin,
      {},
      [400],
    );
    expectApiError(missingVideoIoPrompt.body);
    expect(missingVideoIoPrompt.body.error.message).toBe("prompt is required");

    const unsupportedVideoRatio = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        aspectRatio: "10:1",
      },
      [400],
    );
    expectApiError(unsupportedVideoRatio.body);
    expect(unsupportedVideoRatio.body.error.message).toBe(
      "Unsupported video aspect ratio: 10:1",
    );

    const unsupportedVideoDuration = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        duration: "99s",
      },
      [400],
    );
    expectApiError(unsupportedVideoDuration.body);
    expect(unsupportedVideoDuration.body.error.message).toBe(
      "Unsupported video duration: 99s",
    );

    const unsupportedVideoResolution = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        resolution: "1080p",
      },
      [400],
    );
    expectApiError(unsupportedVideoResolution.body);
    expect(unsupportedVideoResolution.body.error.message).toBe(
      "Unsupported video resolution for dreamina-seedance-2.0-fast: 1080p",
    );

    const invalidVideoSeed = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        seed: -1,
      },
      [400],
    );
    expectApiError(invalidVideoSeed.body);
    expect(invalidVideoSeed.body.error.message).toBe(
      "seed must be a non-negative safe integer",
    );

    const unsupportedReferenceImages = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        model: "veo3.1-fast",
        imageUrls: ["https://assets.example.test/reference.png"],
      },
      [400],
    );
    expectApiError(unsupportedReferenceImages.body);
    expect(unsupportedReferenceImages.body.error.message).toBe(
      "Reference images are not supported for veo3.1-fast",
    );

    const tooManyReferenceVideos = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        videoUrls: [
          "https://assets.example.test/one.mp4",
          "https://assets.example.test/two.mp4",
          "https://assets.example.test/three.mp4",
          "https://assets.example.test/four.mp4",
        ],
      },
      [400],
    );
    expectApiError(tooManyReferenceVideos.body);
    expect(tooManyReferenceVideos.body.error.message).toBe(
      "reference video URLs cannot exceed 3 items",
    );

    const referenceAudioWithoutVisual = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        audioUrls: ["https://assets.example.test/audio.wav"],
      },
      [400],
    );
    expectApiError(referenceAudioWithoutVisual.body);
    expect(referenceAudioWithoutVisual.body.error.message).toBe(
      "reference audio requires at least one image or video reference",
    );

    const tooManyReferenceAudioFiles = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        imageUrls: ["https://assets.example.test/reference.png"],
        audioUrls: [
          "https://assets.example.test/one.wav",
          "https://assets.example.test/two.wav",
        ],
      },
      [400],
    );
    expectApiError(tooManyReferenceAudioFiles.body);
    expect(tooManyReferenceAudioFiles.body.error.message).toBe(
      "reference audio URLs cannot exceed 1 item",
    );

    const unsupportedFirstFrame = await api.requestVideoIoGenerate(
      admin,
      {
        prompt: "animated billing usage chart",
        model: "veo3.1-fast",
        firstFrameImageUrl: "https://assets.example.test/first.png",
      },
      [400],
    );
    expectApiError(unsupportedFirstFrame.body);
    expect(unsupportedFirstFrame.body.error.message).toBe(
      "First frame image is not supported for veo3.1-fast",
    );

    const videoIo = await api.requestVideoIoGenerate(
      admin,
      { prompt: "animated billing usage chart" },
      [402],
    );
    expectApiError(videoIo.body);
    expect(videoIo.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const missingGeneration = await api.readBuiltInGeneration(
      admin,
      undefined,
      [404],
    );
    expectApiError(missingGeneration.body);
    expect(missingGeneration.body.error.message).toBe(
      "Built-in generation not found",
    );

    const status = await api.readBillingStatus(admin);
    expect(status.credits).toBe(0);

    const usageRecord = await api.readUsageRecord(admin);
    expect(usageRecord.body.rows).toStrictEqual([]);
  });
});

describe("BILL-02: maps and banking visible boundaries", () => {
  it("covers maps provider/pricing errors and banking credential gating through public routes", async () => {
    const { api, admin } = testActors();
    await completeVisibleOnboarding(api, admin);

    const missingMapsProvider = await api.requestMapsGeocode(
      admin,
      { address: "1 Market Street, San Francisco" },
      [503],
    );
    expectApiError(missingMapsProvider.body);
    expect(missingMapsProvider.body.error.code).toBe("NOT_CONFIGURED");

    const unauthenticatedDirections = await api.requestMapsDirections(
      null,
      {
        origin: "San Francisco",
        destination: "Oakland",
      },
      [401],
    );
    expectApiError(unauthenticatedDirections.body);
    expect(unauthenticatedDirections.body.error.code).toBe("UNAUTHORIZED");

    const invalidReverseGeocode = await api.requestMapsReverseGeocode(
      admin,
      { lat: 91, lng: -122.4194 },
      [400],
    );
    expectApiError(invalidReverseGeocode.body);
    expect(invalidReverseGeocode.body.error.code).toBe("BAD_REQUEST");

    api.configureMapsProvider();
    const invalidPlacesSearch = await api.requestMapsPlacesSearch(
      admin,
      { query: "coffee", radius: 1000 },
      [400],
    );
    expectApiError(invalidPlacesSearch.body);
    expect(invalidPlacesSearch.body.error.message).toBe(
      "location is required when radius is provided",
    );

    const invalidPlacesLocation = await api.requestMapsPlacesSearch(
      admin,
      { query: "coffee", location: "San Francisco", radius: 1000 },
      [400],
    );
    expectApiError(invalidPlacesLocation.body);
    expect(invalidPlacesLocation.body.error.message).toBe(
      "location must be formatted as lat,lng",
    );

    const insufficientMapsCredits = await api.requestMapsGeocode(
      admin,
      { address: "1 Market Street, San Francisco" },
      [402],
    );
    expectApiError(insufficientMapsCredits.body);
    expect(insufficientMapsCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const insufficientReverseCredits = await api.requestMapsReverseGeocode(
      admin,
      { lat: 37.7749, lng: -122.4194 },
      [402],
    );
    expectApiError(insufficientReverseCredits.body);
    expect(insufficientReverseCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const insufficientDirectionsCredits = await api.requestMapsDirections(
      admin,
      {
        origin: "San Francisco",
        destination: "Oakland",
        departureTime: "now",
      },
      [402],
    );
    expectApiError(insufficientDirectionsCredits.body);
    expect(insufficientDirectionsCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const insufficientPlaceDetailsCredits = await api.requestMapsPlacesDetails(
      admin,
      { placeId: "places/bdd-place", fields: "pro" },
      [402],
    );
    expectApiError(insufficientPlaceDetailsCredits.body);
    expect(insufficientPlaceDetailsCredits.body.error.code).toBe(
      "INSUFFICIENT_CREDITS",
    );

    const bankingWithSession = await api.requestBankingAccounts(admin, [403]);
    expectApiError(bankingWithSession.body);
    expect(bankingWithSession.body.error.message).toBe(
      "This endpoint does not accept the provided credential type",
    );
  });
});
