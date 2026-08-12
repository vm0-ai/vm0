import { describe, expect, it } from "vitest";

import { resolveWebsiteTemplateArchiveVersionId } from "../website-template-archive-versions";

describe("Website template archive versions", () => {
  it("resolves the current stable version", () => {
    const currentSha256 =
      "38b2f826a86901e113b6e96b52563a839b729fc025fa793b1816d6149221bcf9";

    expect(
      resolveWebsiteTemplateArchiveVersionId(
        "template:black-slabs",
        currentSha256,
        currentSha256,
      ),
    ).toBe("63e7780407504c15df178658ef2f694baa23d0a2a4199f38ac07fd9a302f5dac");
  });

  it("keeps the previous stable version addressable by SHA-256", () => {
    expect(
      resolveWebsiteTemplateArchiveVersionId(
        "template:black-slabs",
        "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3",
        "38b2f826a86901e113b6e96b52563a839b729fc025fa793b1816d6149221bcf9",
      ),
    ).toBe("eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22");
  });

  it("keeps the additive v2 resource unchanged", () => {
    const v2Sha256 =
      "de6f78c5a524cf3959ca56af7a93ec5bca113555bbd1a5983eebf1bc353971d4";

    expect(
      resolveWebsiteTemplateArchiveVersionId(
        "template:black-slabs-v2",
        v2Sha256,
        v2Sha256,
      ),
    ).toBe("3a7ccdd16e0c710cf20a0deddbd02d3a58a8125d2b3542648bc261bbaf9c5c91");
  });

  it("does not accept unknown hashes or Presentation resources", () => {
    expect(
      resolveWebsiteTemplateArchiveVersionId(
        "template:black-slabs",
        "unknown",
        "38b2f826a86901e113b6e96b52563a839b729fc025fa793b1816d6149221bcf9",
      ),
    ).toBeUndefined();
    expect(
      resolveWebsiteTemplateArchiveVersionId(
        "template:html-ppt-schoolhouse-runbook",
        "44e95a44ac37174b6dec3e2a2b21c0fe7d6d9f83c254d86cff1779030d5b11ad",
        "44e95a44ac37174b6dec3e2a2b21c0fe7d6d9f83c254d86cff1779030d5b11ad",
      ),
    ).toBeUndefined();
  });
});
