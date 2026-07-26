import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { resolvePrivateRegistryResourceArchive } from "../registry-resources-download";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const routeMocks = createZeroRouteMocks(context);

function authHeaders() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  routeMocks.clerk.session(userId, orgId, "org:admin");
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(registryResourceDownloadContract);
}

describe("registry resource download", () => {
  it("resolves the presentation archive for the current registry digest", () => {
    const currentSha256 =
      "44e95a44ac37174b6dec3e2a2b21c0fe7d6d9f83c254d86cff1779030d5b11ad";

    expect(
      resolvePrivateRegistryResourceArchive(
        "template:html-ppt-schoolhouse-runbook",
        currentSha256,
        currentSha256,
      ),
    ).toStrictEqual({
      storageName: "registry-resource@template:html-ppt-schoolhouse-runbook",
      versionId:
        "c063961c29369b15b8ae7a3cb285105bc29dbae84cccc36d458b666a5ca75e06",
      sha256: currentSha256,
    });
  });

  it("rejects a registry digest that differs from the current registry", () => {
    expect(
      resolvePrivateRegistryResourceArchive(
        "template:html-ppt-schoolhouse-runbook",
        "9bd19af256dfb6f17073ec9af52ed0163a5f432a3d143eb82f1fa67aaf8b015e",
        "44e95a44ac37174b6dec3e2a2b21c0fe7d6d9f83c254d86cff1779030d5b11ad",
      ),
    ).toBeUndefined();
  });

  it("resolves every refreshed additive website v2 archive", () => {
    const currentSha256 =
      "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3";

    expect(
      resolvePrivateRegistryResourceArchive(
        "template:black-slabs",
        currentSha256,
        currentSha256,
      ),
    ).toMatchObject({
      versionId:
        "eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22",
      sha256: currentSha256,
    });

    const v2Archives = [
      {
        id: "template:black-slabs-v2",
        versionId:
          "3a7ccdd16e0c710cf20a0deddbd02d3a58a8125d2b3542648bc261bbaf9c5c91",
        sha256:
          "de6f78c5a524cf3959ca56af7a93ec5bca113555bbd1a5983eebf1bc353971d4",
      },
      {
        id: "template:blueprint-grid-v2",
        versionId:
          "c86f579ecca5f29d45eab19ae19157bdc9a9bc14c99cdbf8611b86aaae3aea70",
        sha256:
          "dec02c4fe156566272a92b7386cb032cec7e3a1250dd42429ca3e7f42374dc28",
      },
      {
        id: "template:coastal-hotel-v2",
        versionId:
          "7c13e39abcabf4cb31bdecdac80e096d6e039367e23c55ca0c3e6647d8fb3583",
        sha256:
          "09d239d7a0e1c27334f2c3c8da9e408174cece6bcc8a34342438598db739aa4e",
      },
      {
        id: "template:dot-matrix-v2",
        versionId:
          "9a8977088b02b43d15654674571a88c0128b29076bb8e837d47ddd3a6ea4fd6a",
        sha256:
          "0beb9b1bcb12ace6d3541df269a629af8e3b41c8f9d7e3c3fcfe069655cd9074",
      },
      {
        id: "template:frame-stack-v2",
        versionId:
          "cb8cf528ebfce90e6f78081fbaee0029f2790ff5398ffa0642a6c30c8c1e0c1b",
        sha256:
          "7c4c13eaa22b4185607c6ac6a726dd931fe896b279b38a6267c0105f81214f8b",
      },
      {
        id: "template:frosted-scatter-v2",
        versionId:
          "7cab5008dbe877dd5ac43e3511d06109d101dda389bbdcc4589396ff495d9d41",
        sha256:
          "c67a7baf924ae4b57241e61527dd875d084e38040653a9bbcc659c13d2382cf9",
      },
      {
        id: "template:gallery-wall-v2",
        versionId:
          "c208b3119387422c4487d1a9a6f3c8f1618d0ee77dcfd51cbe26e6b4092cb002",
        sha256:
          "f6e41fb711b8c9317a425b463a9812e99f2aecb630d1acbfb77ef0965c2ba55f",
      },
      {
        id: "template:glass-bloom-v2",
        versionId:
          "fe6ac8450b6f822707c3e38c2705b2b88828c9226befa090086dc53635d9f9b6",
        sha256:
          "713fbac57cf37a0ddd6d7e7d79a0b9f29f8fff7a0aa55bc741bc5dcd0e498d25",
      },
      {
        id: "template:serif-stack-v2",
        versionId:
          "e61f178818ccf31a0676ca0183fccbaef3019972adab592d8a5ba17287f54f65",
        sha256:
          "6d5d65fb21d6c5ec5627fe32fbfc55e80841a2343f2d91bf3ee3a0f62547766a",
      },
      {
        id: "template:sticker-pop-v2",
        versionId:
          "d358cbcd29fc725fc282f4675ebba533fd60af564038d8efa0d4a057a29aee5b",
        sha256:
          "61954f4652e2cc86cd1016a537078ea050fe95735a7477e6bd56c91a0c0aec3b",
      },
      {
        id: "template:warm-cards-v2",
        versionId:
          "f587c890c6db593a4cd102cb863f2484868277200d5630b40712ee8b2ded3153",
        sha256:
          "213197ef200b16738b51b5d6c4a90b6e6c12c86c63207ef6afc31456cdd0d2e1",
      },
    ] as const;

    for (const archive of v2Archives) {
      expect(
        resolvePrivateRegistryResourceArchive(
          archive.id,
          archive.sha256,
          archive.sha256,
        ),
      ).toMatchObject({
        versionId: archive.versionId,
        sha256: archive.sha256,
      });
    }
  });

  it("rejects registry resources that are not in the private archive allowlist", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id: "template:dashboard", expectedSha256: "0".repeat(64) },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
