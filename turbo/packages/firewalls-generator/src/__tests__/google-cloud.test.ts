import { describe, expect, it } from "vitest";

import { extractOfficialPermissionNames } from "../google-cloud";

describe("extractOfficialPermissionNames", () => {
  it("normalizes Google documentation word-break tags inside permission names", () => {
    expect(
      extractOfficialPermissionNames(
        "datastore.<wbr>keyVisualizerScans.<wbr>get",
      ),
    ).toEqual(["datastore.keyVisualizerScans.get"]);
  });

  it("does not treat Google API hosts as IAM permissions", () => {
    expect(
      extractOfficialPermissionNames(
        "Use https://compute.googleapis.com and compute.googleapis.cn",
      ),
    ).toEqual([]);
  });
});
