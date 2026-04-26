import { beforeEach, describe, expect, it, vi } from "vitest";

const otel = vi.hoisted(() => {
  return {
    registerOTel: vi.fn(),
  };
});

const sentry = vi.hoisted(() => {
  return {
    captureException: vi.fn(),
    init: vi.fn(),
  };
});

vi.mock("@sentry/node", () => {
  return sentry;
});

vi.mock("@vercel/otel", () => {
  return otel;
});

async function importInstrument(
  configureEnv?: (envModule: typeof import("../lib/env")) => void,
): Promise<void> {
  vi.resetModules();
  const envModule = await import("../lib/env");
  configureEnv?.(envModule);
  await import("../instrument");
}

describe("instrument", () => {
  beforeEach(() => {
    otel.registerOTel.mockReset();
    sentry.init.mockReset();
  });

  it("registers OpenTelemetry with api metadata", async () => {
    await importInstrument((envModule) => {
      envModule.mockEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    });

    expect(otel.registerOTel).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: {
          "service.version": "abc123",
        },
        serviceName: "vm0-api",
        traceExporter: "auto",
      }),
    );
  });

  it("does not initialize Sentry without a DSN", async () => {
    await importInstrument((envModule) => {
      envModule.mockEnv("SENTRY_DSN", undefined);
    });

    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("initializes Sentry with api metadata", async () => {
    await importInstrument((envModule) => {
      envModule.mockEnv(
        "SENTRY_DSN",
        "https://examplePublicKey@o0.ingest.sentry.io/0",
      );
      envModule.mockEnv("VERCEL_ENV", "production");
      envModule.mockEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    });

    expect(sentry.init).toHaveBeenCalledWith({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      environment: "production",
      initialScope: {
        tags: {
          app: "api",
        },
      },
      release: "abc123",
      sendDefaultPii: false,
      shutdownTimeout: 500,
      tracesSampleRate: 0,
    });
  });
});
