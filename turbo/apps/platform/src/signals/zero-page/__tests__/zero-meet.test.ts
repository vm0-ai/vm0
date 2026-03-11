import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroInstructions$,
  zeroInstructionsLoading$,
  zeroEditedContent$,
  zeroInstructionsDirty$,
  zeroBuildingInstructions$,
  zeroBuildError$,
  zeroFetchError$,
  fetchZeroInstructions$,
  setZeroEditedContent$,
  discardZeroEdit$,
  buildZeroInstructions$,
} from "../zero-meet.ts";

const context = testContext();

async function setup() {
  await setupPage({
    context,
    path: "/zero/meet",
    withoutRender: true,
  });
}

describe("zero-meet signals", () => {
  describe("fetchZeroInstructions$", () => {
    it("should fetch instructions and compose detail", async () => {
      server.use(
        http.get("/api/agent/composes/:id/instructions", () => {
          return HttpResponse.json({
            content: "You are a helpful assistant.",
            filename: "INSTRUCTIONS.md",
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroInstructions$);

      const instructions = context.store.get(zeroInstructions$);
      expect(instructions).toStrictEqual({
        content: "You are a helpful assistant.",
        filename: "INSTRUCTIONS.md",
      });
      expect(context.store.get(zeroInstructionsLoading$)).toBeFalsy();
      expect(context.store.get(zeroFetchError$)).toBeNull();
    });

    it("should set error when instructions fetch fails", async () => {
      server.use(
        http.get("/api/agent/composes/:id/instructions", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await context.store.set(fetchZeroInstructions$);

      expect(context.store.get(zeroInstructions$)).toBeNull();
      expect(context.store.get(zeroInstructionsLoading$)).toBeFalsy();
      expect(context.store.get(zeroFetchError$)).toBe(
        "Failed to load instructions.",
      );
    });

    it("should set error when compose fetch fails", async () => {
      server.use(
        http.get("/api/agent/composes/:id", ({ params }) => {
          if (params.id === "list") {
            return;
          }
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await context.store.set(fetchZeroInstructions$);

      expect(context.store.get(zeroInstructions$)).toBeNull();
      expect(context.store.get(zeroFetchError$)).toBe(
        "Failed to load instructions.",
      );
    });

    it("should handle null instructions content", async () => {
      await setup();
      await context.store.set(fetchZeroInstructions$);

      const instructions = context.store.get(zeroInstructions$);
      expect(instructions).toStrictEqual({ content: null, filename: null });
    });
  });

  describe("editing state", () => {
    it("should track edited content", async () => {
      await setup();
      expect(context.store.get(zeroEditedContent$)).toBeNull();

      context.store.set(setZeroEditedContent$, "new content");
      expect(context.store.get(zeroEditedContent$)).toBe("new content");
    });

    it("should mark dirty when content differs from instructions", async () => {
      server.use(
        http.get("/api/agent/composes/:id/instructions", () => {
          return HttpResponse.json({
            content: "original",
            filename: null,
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroInstructions$);

      expect(context.store.get(zeroInstructionsDirty$)).toBeFalsy();

      context.store.set(setZeroEditedContent$, "modified");
      expect(context.store.get(zeroInstructionsDirty$)).toBeTruthy();

      context.store.set(setZeroEditedContent$, "original");
      expect(context.store.get(zeroInstructionsDirty$)).toBeFalsy();
    });

    it("should discard edited content", async () => {
      await setup();
      context.store.set(setZeroEditedContent$, "some edits");
      expect(context.store.get(zeroEditedContent$)).toBe("some edits");

      context.store.set(discardZeroEdit$);
      expect(context.store.get(zeroEditedContent$)).toBeNull();
      expect(context.store.get(zeroInstructionsDirty$)).toBeFalsy();
    });
  });

  describe("buildZeroInstructions$", () => {
    it("should build instructions and update state", async () => {
      server.use(
        http.get("/api/agent/composes/:id/instructions", () => {
          return HttpResponse.json({
            content: "original",
            filename: "INSTRUCTIONS.md",
          });
        }),
        http.post("/api/compose/jobs", () => {
          return HttpResponse.json({
            jobId: "job-1",
            status: "completed",
            result: {
              composeId: "compose-1",
              composeName: "zero",
              versionId: "v-1",
              warnings: [],
            },
          });
        }),
      );

      await setup();
      await context.store.set(fetchZeroInstructions$);
      context.store.set(setZeroEditedContent$, "updated instructions");

      await context.store.set(buildZeroInstructions$);

      expect(context.store.get(zeroBuildingInstructions$)).toBeFalsy();
      expect(context.store.get(zeroBuildError$)).toBeNull();
      expect(context.store.get(zeroEditedContent$)).toBeNull();
      expect(context.store.get(zeroInstructions$)).toStrictEqual({
        content: "updated instructions",
        filename: "INSTRUCTIONS.md",
      });
    });

    it("should set error when build fails", async () => {
      server.use(
        http.get("/api/agent/composes/:id/instructions", () => {
          return HttpResponse.json({
            content: "original",
            filename: null,
          });
        }),
        http.post("/api/compose/jobs", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await setup();
      await context.store.set(fetchZeroInstructions$);
      context.store.set(setZeroEditedContent$, "new content");

      await context.store.set(buildZeroInstructions$);

      expect(context.store.get(zeroBuildingInstructions$)).toBeFalsy();
      expect(context.store.get(zeroBuildError$)).toBe(
        "Failed to build instructions. Please try again.",
      );
      // Edited content should be preserved on failure
      expect(context.store.get(zeroEditedContent$)).toBe("new content");
    });

    it("should not build without compose detail", async () => {
      await setup();
      context.store.set(setZeroEditedContent$, "some content");

      // No fetchZeroInstructions$ called, so no compose detail
      await context.store.set(buildZeroInstructions$);

      expect(context.store.get(zeroBuildingInstructions$)).toBeFalsy();
    });

    it("should not build without edited content", async () => {
      await setup();
      await context.store.set(fetchZeroInstructions$);

      // No setZeroEditedContent$ called
      await context.store.set(buildZeroInstructions$);

      expect(context.store.get(zeroBuildingInstructions$)).toBeFalsy();
    });
  });
});
