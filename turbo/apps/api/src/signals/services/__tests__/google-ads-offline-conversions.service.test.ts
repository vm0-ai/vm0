import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  formatGoogleAdsConversionDateTime,
  uploadGoogleAdsOfflineConversion,
} from "../google-ads-offline-conversions.service";

const GOOGLE_ADS_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ADS_UPLOAD_URL =
  "https://googleads.googleapis.com/v24/customers/1001302527:uploadClickConversions";

function configureGoogleAdsOfflineConversionEnv(): void {
  mockOptionalEnv("GOOGLE_ADS_OFFLINE_CUSTOMER_ID", "100-130-2527");
  mockOptionalEnv("GOOGLE_ADS_OFFLINE_LOGIN_CUSTOMER_ID", "999-888-7777");
  mockOptionalEnv("GOOGLE_ADS_OFFLINE_DEVELOPER_TOKEN", "developer-token");
  mockOptionalEnv("GOOGLE_ADS_OFFLINE_CLIENT_ID", "oauth-client-id");
  mockOptionalEnv("GOOGLE_ADS_OFFLINE_CLIENT_SECRET", "oauth-client-secret");
  mockOptionalEnv("GOOGLE_ADS_OFFLINE_REFRESH_TOKEN", "refresh-token");
  mockOptionalEnv("GOOGLE_ADS_FREE_TRIAL_CONVERSION_ACTION_ID", "7615812424");
  mockOptionalEnv(
    "GOOGLE_ADS_PAID_SUBSCRIBER_CONVERSION_ACTION_ID",
    "9876543210",
  );
}

function requiredValue<T>(value: T | null): T {
  expect(value).not.toBeNull();
  if (value === null) {
    throw new Error("Expected value to be set");
  }
  return value;
}

describe("Google Ads offline conversions", () => {
  it("formats conversion time in the Google Ads API timezone format", () => {
    expect(
      formatGoogleAdsConversionDateTime(new Date("2026-06-10T12:34:56.789Z")),
    ).toBe("2026-06-10 12:34:56+00:00");
  });

  it("uploads free trial conversions with checkout session order id", async () => {
    configureGoogleAdsOfflineConversionEnv();
    const captured: {
      tokenRequest: URLSearchParams | null;
      uploadHeaders: Headers | null;
      uploadBody: unknown;
    } = {
      tokenRequest: null,
      uploadHeaders: null,
      uploadBody: null,
    };

    server.use(
      http.post(GOOGLE_ADS_TOKEN_URL, async ({ request }) => {
        captured.tokenRequest = new URLSearchParams(await request.text());
        return HttpResponse.json({ access_token: "access-token" });
      }),
      http.post(GOOGLE_ADS_UPLOAD_URL, async ({ request }) => {
        captured.uploadHeaders = request.headers;
        captured.uploadBody = await request.json();
        return HttpResponse.json({
          results: [
            {
              conversionAction:
                "customers/1001302527/conversionActions/7615812424",
              orderId: "cs_test_trial",
            },
          ],
          jobId: "123",
        });
      }),
    );

    await uploadGoogleAdsOfflineConversion({
      kind: "free_trial",
      tier: "pro",
      transactionId: "cs_test_trial",
      conversionTime: new Date("2026-06-10T12:34:56.000Z"),
      metadata: { gclid: "test-gclid" },
    });

    const requestParams = requiredValue(captured.tokenRequest);
    const requestHeaders = requiredValue(captured.uploadHeaders);
    expect(requestParams.get("client_id")).toBe("oauth-client-id");
    expect(requestParams.get("client_secret")).toBe("oauth-client-secret");
    expect(requestParams.get("refresh_token")).toBe("refresh-token");
    expect(requestParams.get("grant_type")).toBe("refresh_token");
    expect(requestHeaders.get("authorization")).toBe("Bearer access-token");
    expect(requestHeaders.get("developer-token")).toBe("developer-token");
    expect(requestHeaders.get("login-customer-id")).toBe("9998887777");
    expect(captured.uploadBody).toStrictEqual({
      conversions: [
        {
          gclid: "test-gclid",
          conversionAction: "customers/1001302527/conversionActions/7615812424",
          conversionDateTime: "2026-06-10 12:34:56+00:00",
          conversionValue: 20,
          currencyCode: "USD",
          orderId: "cs_test_trial",
          conversionEnvironment: "WEB",
        },
      ],
      partialFailure: true,
    });
  });

  it("uploads paid subscriber conversions with invoice order id and paid amount", async () => {
    configureGoogleAdsOfflineConversionEnv();
    let uploadBody: unknown = null;

    server.use(
      http.post(GOOGLE_ADS_TOKEN_URL, () => {
        return HttpResponse.json({ access_token: "access-token" });
      }),
      http.post(GOOGLE_ADS_UPLOAD_URL, async ({ request }) => {
        uploadBody = await request.json();
        return HttpResponse.json({ results: [], jobId: "456" });
      }),
    );

    await uploadGoogleAdsOfflineConversion({
      kind: "paid_subscriber",
      tier: "team",
      transactionId: "inv_test_team",
      conversionTime: new Date("2026-06-10T13:00:00.000Z"),
      metadata: { gbraid: "test-gbraid" },
      conversionValueUsd: 123.45,
    });

    expect(uploadBody).toStrictEqual({
      conversions: [
        {
          gbraid: "test-gbraid",
          conversionAction: "customers/1001302527/conversionActions/9876543210",
          conversionDateTime: "2026-06-10 13:00:00+00:00",
          conversionValue: 123.45,
          currencyCode: "USD",
          orderId: "inv_test_team",
          conversionEnvironment: "WEB",
        },
      ],
      partialFailure: true,
    });
  });

  it("uses the shared Google Ads login customer fallback", async () => {
    mockOptionalEnv("GOOGLE_ADS_OFFLINE_CUSTOMER_ID", "1001302527");
    mockOptionalEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", "123-456-7890");
    mockOptionalEnv("GOOGLE_ADS_OFFLINE_DEVELOPER_TOKEN", "developer-token");
    mockOptionalEnv("GOOGLE_ADS_OFFLINE_CLIENT_ID", "oauth-client-id");
    mockOptionalEnv("GOOGLE_ADS_OFFLINE_CLIENT_SECRET", "oauth-client-secret");
    mockOptionalEnv("GOOGLE_ADS_OFFLINE_REFRESH_TOKEN", "refresh-token");
    mockOptionalEnv("GOOGLE_ADS_FREE_TRIAL_CONVERSION_ACTION_ID", "7615812424");
    const captured: { uploadHeaders: Headers | null } = {
      uploadHeaders: null,
    };

    server.use(
      http.post(GOOGLE_ADS_TOKEN_URL, () => {
        return HttpResponse.json({ access_token: "access-token" });
      }),
      http.post(GOOGLE_ADS_UPLOAD_URL, ({ request }) => {
        captured.uploadHeaders = request.headers;
        return HttpResponse.json({ results: [], jobId: "456" });
      }),
    );

    await uploadGoogleAdsOfflineConversion({
      kind: "free_trial",
      tier: "pro",
      transactionId: "cs_test_trial",
      conversionTime: new Date("2026-06-10T13:00:00.000Z"),
      metadata: { gclid: "test-gclid" },
    });

    expect(requiredValue(captured.uploadHeaders).get("login-customer-id")).toBe(
      "1234567890",
    );
  });

  it("retries transient Google Ads upload failures", async () => {
    configureGoogleAdsOfflineConversionEnv();
    let uploadCalls = 0;
    let uploadBody: unknown = null;

    server.use(
      http.post(GOOGLE_ADS_TOKEN_URL, () => {
        return HttpResponse.json({ access_token: "access-token" });
      }),
      http.post(GOOGLE_ADS_UPLOAD_URL, async ({ request }) => {
        uploadCalls += 1;
        if (uploadCalls === 1) {
          return HttpResponse.json(
            { error: { message: "temporary unavailable" } },
            { status: 503 },
          );
        }
        uploadBody = await request.json();
        return HttpResponse.json({ results: [], jobId: "789" });
      }),
    );

    await uploadGoogleAdsOfflineConversion({
      kind: "free_trial",
      tier: "pro",
      transactionId: "cs_test_retry",
      conversionTime: new Date("2026-06-10T12:34:56.000Z"),
      metadata: { gclid: "test-gclid" },
    });

    expect(uploadCalls).toBe(2);
    expect(uploadBody).toStrictEqual({
      conversions: [
        {
          gclid: "test-gclid",
          conversionAction: "customers/1001302527/conversionActions/7615812424",
          conversionDateTime: "2026-06-10 12:34:56+00:00",
          conversionValue: 20,
          currencyCode: "USD",
          orderId: "cs_test_retry",
          conversionEnvironment: "WEB",
        },
      ],
      partialFailure: true,
    });
  });

  it("does not call Google Ads when no click id is available", async () => {
    configureGoogleAdsOfflineConversionEnv();
    let tokenCalls = 0;
    let uploadCalls = 0;

    server.use(
      http.post(GOOGLE_ADS_TOKEN_URL, () => {
        tokenCalls += 1;
        return HttpResponse.json({ access_token: "access-token" });
      }),
      http.post(GOOGLE_ADS_UPLOAD_URL, () => {
        uploadCalls += 1;
        return HttpResponse.json({ results: [], jobId: "789" });
      }),
    );

    await uploadGoogleAdsOfflineConversion({
      kind: "free_trial",
      tier: "pro",
      transactionId: "cs_test_no_click",
      conversionTime: new Date("2026-06-10T12:34:56.000Z"),
      metadata: { vm0_source: "presentation" },
    });

    expect(tokenCalls).toBe(0);
    expect(uploadCalls).toBe(0);
  });
});
