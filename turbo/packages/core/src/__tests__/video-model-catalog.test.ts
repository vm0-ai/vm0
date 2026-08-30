import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIDEO_MODEL,
  PUBLIC_VIDEO_MODELS,
} from "../video-model-catalog";

describe("video model catalog", () => {
  it("offers the system default in the picker", () => {
    // A private default is invisible: the picker marks its selection by
    // matching the resolved model against the rows it offers, so an untouched
    // thread would show no selection at all while its runs use this model.
    expect(PUBLIC_VIDEO_MODELS).toContain(DEFAULT_VIDEO_MODEL);
  });
});
