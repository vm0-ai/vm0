import { describe, expect, it } from "vitest";
import {
  normalizeClerkProductionPrimaryAppDomain,
  resolveClerkProductionSatelliteDomain,
  resolveClerkProductionTopology,
} from "../clerk-production-topology.ts";

const CURRENT_PRIMARY_APP_DOMAIN = "app.vm0.ai";
const CUTOVER_PRIMARY_APP_DOMAIN = "app.okou.ai";

describe("clerk production topology", () => {
  it("keeps the deployed VM0 primary topology for the current satellite", () => {
    expect(
      resolveClerkProductionTopology(CURRENT_PRIMARY_APP_DOMAIN),
    ).toStrictEqual({
      primaryAppOrigin: "https://app.vm0.ai",
      primaryBrand: "vm0",
      primaryUserProfileUrl: "https://accounts.vm0.ai/user",
    });
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.okou.ai",
        CURRENT_PRIMARY_APP_DOMAIN,
      ),
    ).toBe("app.okou.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.vm0.ai",
        CURRENT_PRIMARY_APP_DOMAIN,
      ),
    ).toBeNull();
  });

  it("switches VM0 hosts to the root satellite when Okou is primary", () => {
    expect(
      resolveClerkProductionTopology(CUTOVER_PRIMARY_APP_DOMAIN),
    ).toStrictEqual({
      primaryAppOrigin: "https://app.okou.ai",
      primaryBrand: "okou",
      primaryUserProfileUrl: "https://accounts.vm0.ai/user",
    });
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.okou.ai",
        CUTOVER_PRIMARY_APP_DOMAIN,
      ),
    ).toBeNull();
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.vm0.ai",
        CUTOVER_PRIMARY_APP_DOMAIN,
      ),
    ).toBe("vm0.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "www.vm0.ai",
        CUTOVER_PRIMARY_APP_DOMAIN,
      ),
    ).toBe("vm0.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "vm0.ai.evil.example",
        CUTOVER_PRIMARY_APP_DOMAIN,
      ),
    ).toBeNull();
  });

  it("falls back to the rollback-safe current topology for an unknown value", () => {
    expect(normalizeClerkProductionPrimaryAppDomain("invalid-domain")).toBe(
      CURRENT_PRIMARY_APP_DOMAIN,
    );
    expect(resolveClerkProductionTopology("invalid-domain")).toMatchObject({
      primaryAppOrigin: "https://app.vm0.ai",
      primaryBrand: "vm0",
    });
  });
});
