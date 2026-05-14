import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { ProviderIcon } from "../components/settings/provider-icons.tsx";

describe("provider icons", () => {
  it("applies dark-mode inversion to low-contrast provider marks", () => {
    for (const type of [
      "openai-api-key",
      "codex-oauth-token",
      "moonshot-api-key",
      "zai-api-key",
    ] as const) {
      const { container, unmount } = render(<ProviderIcon type={type} />);
      expect(container.querySelector("img")).toHaveClass("zero-icon-mono");
      unmount();
    }
  });

  it("does not invert colorful provider marks", () => {
    const { container } = render(<ProviderIcon type="anthropic-api-key" />);
    expect(container.querySelector("img")).not.toHaveClass("zero-icon-mono");
  });
});
