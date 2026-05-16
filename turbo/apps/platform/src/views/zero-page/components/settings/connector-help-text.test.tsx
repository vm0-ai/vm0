import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ConnectorHelpText } from "./connector-help-text.tsx";

describe("ConnectorHelpText", () => {
  it("renders supported connector help markdown", () => {
    render(
      <ConnectorHelpText
        text={
          "Use **test mode** and [open docs](https://example.com/docs).\n> Keep this key private."
        }
      />,
    );

    const boldText = screen.getByText("test mode");
    expect(boldText.tagName).toBe("STRONG");

    const link = screen.getByRole("link", { name: "open docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    expect(screen.getByText("Keep this key private.")).toHaveClass(
      "border-l-2",
    );
  });

  it("renders unsupported or unsafe HTML as text", () => {
    const { container } = render(
      <ConnectorHelpText
        text={
          '<img src=x onerror=alert(1)> [bad <b>label</b>](https://example.com/" onclick="alert(1)) **<script>bad()</script>**'
        }
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(container).toHaveTextContent("<script>bad()</script>");
  });
});
