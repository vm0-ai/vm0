import { describe, expect, it } from "vitest";
import {
  resolveClerkProductionSatelliteDomain,
  resolveClerkProductionTopology,
} from "../clerk-production-topology.ts";

const VM0_PRIMARY_PUBLISHABLE_KEY = "pk_live_Y2xlcmsudm0wLmFpJA";
const OKOU_PRIMARY_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuYXBwLm9rb3UuYWkk";

describe("clerk production topology", () => {
  it("keeps the deployed VM0 primary topology for the legacy key", () => {
    expect(
      resolveClerkProductionTopology(VM0_PRIMARY_PUBLISHABLE_KEY),
    ).toStrictEqual({
      primaryAppOrigin: "https://app.vm0.ai",
      primaryBrand: "vm0",
      primaryUserProfileUrl: "https://accounts.vm0.ai/user",
    });
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.okou.ai",
        VM0_PRIMARY_PUBLISHABLE_KEY,
      ),
    ).toBe("app.okou.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.vm0.ai",
        VM0_PRIMARY_PUBLISHABLE_KEY,
      ),
    ).toBeNull();
  });

  it("switches VM0 hosts to the root satellite when Okou is primary", () => {
    expect(
      resolveClerkProductionTopology(OKOU_PRIMARY_PUBLISHABLE_KEY),
    ).toStrictEqual({
      primaryAppOrigin: "https://app.okou.ai",
      primaryBrand: "okou",
      primaryUserProfileUrl: "https://accounts.app.okou.ai/user",
    });
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.okou.ai",
        OKOU_PRIMARY_PUBLISHABLE_KEY,
      ),
    ).toBeNull();
    expect(
      resolveClerkProductionSatelliteDomain(
        "app.vm0.ai",
        OKOU_PRIMARY_PUBLISHABLE_KEY,
      ),
    ).toBe("vm0.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "www.vm0.ai",
        OKOU_PRIMARY_PUBLISHABLE_KEY,
      ),
    ).toBe("vm0.ai");
    expect(
      resolveClerkProductionSatelliteDomain(
        "vm0.ai.evil.example",
        OKOU_PRIMARY_PUBLISHABLE_KEY,
      ),
    ).toBeNull();
  });

  it("falls back to the rollback-safe VM0 topology for an unknown key", () => {
    expect(resolveClerkProductionTopology("invalid-key")).toMatchObject({
      primaryAppOrigin: "https://app.vm0.ai",
      primaryBrand: "vm0",
    });
  });
});
