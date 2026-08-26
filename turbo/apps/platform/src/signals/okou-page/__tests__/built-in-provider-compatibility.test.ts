import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";

import { modelPolicyAllowedForPlan } from "../model-plan-capabilities.ts";
import { getUILabel } from "../../../views/okou-page/components/settings/provider-ui-config.ts";
import { ProviderIcon } from "../../../views/okou-page/components/settings/provider-icons.tsx";

describe("platform built-in provider compatibility", () => {
  it("uses the same localized provider label for both aliases", () => {
    expect(getUILabel("built-in")).toBe(getUILabel("vm0"));
  });

  it("uses the same provider icon for both aliases", () => {
    const legacy = render(createElement(ProviderIcon, { type: "vm0" }));
    const legacyIcon = legacy.container.querySelector("img");
    const canonical = render(createElement(ProviderIcon, { type: "built-in" }));
    const canonicalIcon = canonical.container.querySelector("img");

    expect(legacyIcon).not.toBeNull();
    expect(canonicalIcon?.getAttribute("src")).toBe(
      legacyIcon?.getAttribute("src"),
    );
  });

  it.each(["vm0", "built-in"] as const)(
    "allows the %s alias on a built-in-only plan",
    (defaultProviderType) => {
      expect(
        modelPolicyAllowedForPlan(
          { model: "gpt-5.6-luna", defaultProviderType },
          { supportByok: false, restrictedVm0Models: false },
        ),
      ).toBeTruthy();
    },
  );
});
