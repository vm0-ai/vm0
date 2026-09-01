import { describe, expect, it } from "vitest";
import {
  normalizeClerkProductionSatelliteDomain,
  resolveClerkProductionSatelliteDomain,
  resolveClerkProductionTopology,
} from "../clerk-production-topology.ts";

const CURRENT_SATELLITE_DOMAIN = "app.okou.ai";
const CUTOVER_SATELLITE_DOMAIN = "vm0.ai";

describe("clerk production topology", () => {
  it("keeps the deployed VM0 primary topology for the current satellite", () => {
    expect(
      resolveClerkProductionTopology(CURRENT_SATELLITE_DOMAIN),
    ).toStrictEqual({
      primaryAppOrigin: "https://app.vm0.ai",
      primaryBrand: "vm0",
      primaryUserProfileUrl: "https://accounts.vm0.ai/user",
    });
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.okou.ai",
        CURRENT_SATELLITE_DOMAIN,
      ),
    ).toBe("app.okou.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.vm0.ai",
        CURRENT_SATELLITE_DOMAIN,
      ),
    ).toBeNull();
  });

  it("switches VM0 hosts to the root satellite when Okou is primary", () => {
    expect(
      resolveClerkProductionTopology(CUTOVER_SATELLITE_DOMAIN),
    ).toStrictEqual({
      primaryAppOrigin: "https://app.okou.ai",
      primaryBrand: "okou",
      primaryUserProfileUrl: "https://accounts.vm0.ai/user",
    });
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.okou.ai",
        CUTOVER_SATELLITE_DOMAIN,
      ),
    ).toBeNull();
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.vm0.ai",
        CUTOVER_SATELLITE_DOMAIN,
      ),
    ).toBe("vm0.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "www.vm0.ai",
        CUTOVER_SATELLITE_DOMAIN,
      ),
    ).toBe("vm0.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "vm0.ai.evil.example",
        CUTOVER_SATELLITE_DOMAIN,
      ),
    ).toBeNull();
  });

  it("falls back to the rollback-safe current topology for an unknown value", () => {
    expect(normalizeClerkProductionSatelliteDomain("invalid-domain")).toBe(
      CURRENT_SATELLITE_DOMAIN,
    );
    expect(resolveClerkProductionTopology("invalid-domain")).toMatchObject({
      primaryAppOrigin: "https://app.vm0.ai",
      primaryBrand: "vm0",
    });
  });
});
