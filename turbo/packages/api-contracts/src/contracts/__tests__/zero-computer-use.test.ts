import { describe, expect, it } from "vitest";
import {
  computerUseCommandErrorCodeSchema,
  computerUseHostCommandCompleteBodySchema,
} from "../zero-computer-use";

describe("computer-use contract", () => {
  it.each(["app_not_found", "app_open_failed", "window_unavailable"])(
    "accepts %s command failures",
    (code) => {
      expect(computerUseCommandErrorCodeSchema.parse(code)).toBe(code);
      expect(
        computerUseHostCommandCompleteBodySchema.parse({
          status: "failed",
          error: {
            code,
            message: "Unable to open Things",
          },
        }),
      ).toStrictEqual({
        status: "failed",
        error: {
          code,
          message: "Unable to open Things",
        },
      });
    },
  );
});
