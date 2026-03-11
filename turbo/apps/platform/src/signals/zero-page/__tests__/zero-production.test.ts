import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroArtifacts$,
  zeroArtifactsLoading$,
  zeroArtifactsError$,
  fetchZeroArtifacts$,
  downloadArtifact$,
} from "../zero-production.ts";

const context = testContext();

async function setup() {
  await setupPage({
    context,
    path: "/zero/production",
    withoutRender: true,
  });
}

describe("fetchZeroArtifacts$", () => {
  it("should fetch artifact list", async () => {
    server.use(
      http.get("*/api/storages/list", () => {
        return HttpResponse.json([
          {
            name: "weekly-report",
            size: 24_000,
            fileCount: 1,
            updatedAt: "2026-03-02T12:00:00Z",
          },
          {
            name: "analysis.pdf",
            size: 156_000,
            fileCount: 3,
            updatedAt: "2026-02-28T10:00:00Z",
          },
        ]);
      }),
    );

    await setup();
    await context.store.set(fetchZeroArtifacts$);

    const artifacts = context.store.get(zeroArtifacts$);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].name).toBe("weekly-report");
    expect(artifacts[1].name).toBe("analysis.pdf");
    expect(context.store.get(zeroArtifactsLoading$)).toBeFalsy();
    expect(context.store.get(zeroArtifactsError$)).toBeNull();
  });

  it("should set error when fetch fails", async () => {
    server.use(
      http.get("*/api/storages/list", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await setup();
    await context.store.set(fetchZeroArtifacts$);

    expect(context.store.get(zeroArtifacts$)).toStrictEqual([]);
    expect(context.store.get(zeroArtifactsLoading$)).toBeFalsy();
    expect(context.store.get(zeroArtifactsError$)).toBe(
      "Failed to load documents.",
    );
  });

  it("should handle empty artifact list", async () => {
    server.use(
      http.get("*/api/storages/list", () => {
        return HttpResponse.json([]);
      }),
    );

    await setup();
    await context.store.set(fetchZeroArtifacts$);

    expect(context.store.get(zeroArtifacts$)).toStrictEqual([]);
    expect(context.store.get(zeroArtifactsLoading$)).toBeFalsy();
    expect(context.store.get(zeroArtifactsError$)).toBeNull();
  });
});

describe("downloadArtifact$", () => {
  it("should open presigned URL in new tab", async () => {
    server.use(
      http.get("*/api/platform/artifacts/download", () => {
        return HttpResponse.json({
          url: "https://s3.example.com/presigned-url",
          expiresAt: "2026-03-02T13:00:00Z",
        });
      }),
    );

    const mockOpen = vi.fn(() => ({ closed: false }));
    vi.stubGlobal("open", mockOpen);

    await setup();
    await context.store.set(downloadArtifact$, { name: "weekly-report" });

    expect(mockOpen).toHaveBeenCalledWith(
      "https://s3.example.com/presigned-url",
      "_blank",
    );

    vi.unstubAllGlobals();
  });

  it("should throw when download URL fetch fails", async () => {
    server.use(
      http.get("*/api/platform/artifacts/download", () => {
        return HttpResponse.json(
          { error: { message: "Artifact not found" } },
          { status: 404 },
        );
      }),
    );

    await setup();

    await expect(
      context.store.set(downloadArtifact$, { name: "missing" }),
    ).rejects.toThrow("Artifact not found");
  });
});
