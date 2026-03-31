import { describe, it, expect } from "vitest";
import { filterSecretConnectorMap } from "../build-zero-context";

describe("filterSecretConnectorMap", () => {
  it("returns undefined when input is undefined", () => {
    expect(filterSecretConnectorMap(undefined, [])).toBeUndefined();
  });

  it("returns all keys when no override sources exist", () => {
    const map = {
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-calendar",
      GOOGLE_CALENDAR_TOKEN: "google-calendar",
    };
    expect(filterSecretConnectorMap(map, [])).toEqual(map);
  });

  it("removes keys overridden by CLI secrets", () => {
    const map = {
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-calendar",
      NOTION_ACCESS_TOKEN: "notion",
    };
    const cliSecrets = { NOTION_ACCESS_TOKEN: "manual-value" };
    expect(filterSecretConnectorMap(map, [cliSecrets])).toEqual({
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-calendar",
    });
  });

  it("removes keys overridden by DB secrets", () => {
    const map = {
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-calendar",
      SLACK_ACCESS_TOKEN: "slack",
    };
    const dbSecrets = { SLACK_ACCESS_TOKEN: "db-value" };
    expect(filterSecretConnectorMap(map, [undefined, dbSecrets])).toEqual({
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-calendar",
    });
  });

  it("preserves connector mapped env var names (not treated as overrides)", () => {
    // This is the regression case from #6681: connector's own injected env
    // vars should NOT be passed as an override source.
    const map = {
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-calendar", // raw secret name
      GOOGLE_CALENDAR_TOKEN: "google-calendar", // mapped env var name
    };
    // injectedEnvVars would contain GOOGLE_CALENDAR_TOKEN — but it must NOT
    // be in the override sources array.  Only CLI/DB/model-provider go there.
    expect(filterSecretConnectorMap(map, [])).toEqual(map);
  });

  it("returns undefined when all keys are overridden", () => {
    const map = { NOTION_ACCESS_TOKEN: "notion" };
    const cliSecrets = { NOTION_ACCESS_TOKEN: "manual" };
    expect(filterSecretConnectorMap(map, [cliSecrets])).toBeUndefined();
  });

  it("handles multiple override sources", () => {
    const map = {
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-calendar",
      NOTION_ACCESS_TOKEN: "notion",
      SLACK_ACCESS_TOKEN: "slack",
    };
    const modelProviderSecrets = { NOTION_ACCESS_TOKEN: "mp-value" };
    const cliSecrets = { SLACK_ACCESS_TOKEN: "cli-value" };
    expect(
      filterSecretConnectorMap(map, [
        modelProviderSecrets,
        undefined,
        cliSecrets,
      ]),
    ).toEqual({
      GOOGLE_CALENDAR_ACCESS_TOKEN: "google-calendar",
    });
  });
});
