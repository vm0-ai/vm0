// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AvatarCustomizer } from "../AvatarCustomizer";

vi.mock("next-intl", () => {
  return {
    useTranslations: () => {
      return (key: string) => {
        const labels: Record<string, string> = {
          "steps.rotation": "Angle",
          "steps.skin": "Skin",
          "steps.hairStyle": "Hair",
          "steps.hairColor": "Color",
          "steps.expression": "Face",
          "steps.intensity": "Mood",
          "intensityLabels.chill": "Chill",
          "intensityLabels.normal": "Normal",
          "intensityLabels.hyped": "Hyped",
        };
        return labels[key] ?? key;
      };
    },
  };
});

vi.mock("@tabler/icons-react", () => {
  const Icon = () => {
    return <span aria-hidden="true" />;
  };
  return {
    IconChevronLeft: Icon,
    IconChevronRight: Icon,
    IconDice: Icon,
  };
});

const mockAvatarSvg = `<svg viewBox="0 0 480 480" xmlns="http://www.w3.org/2000/svg"><path d="M1 1h1v1H1z"/></svg>`;

describe("AvatarCustomizer", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: true,
          text: async () => {
            return mockAvatarSvg;
          },
        };
      }),
    );
  });

  it("keeps the default hero avatar selected on first render", () => {
    render(<AvatarCustomizer />);

    expect(screen.getByTestId("hero-avatar-2")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("hero-avatar-1")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("renders composite svg inline instead of png assets", async () => {
    render(<AvatarCustomizer />);

    await waitFor(() => {
      expect(
        screen.getByTestId("hero-avatar-2").querySelector("svg"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByTestId("hero-avatar-2").querySelector("img"),
    ).not.toBeInTheDocument();
  });

  it("moves the selected state when another avatar is picked", async () => {
    render(<AvatarCustomizer />);

    await userEvent.click(screen.getByTestId("hero-avatar-3"));

    expect(screen.getByTestId("hero-avatar-2")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("hero-avatar-3")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps the idle floating animation on hero avatars", () => {
    render(<AvatarCustomizer />);

    expect(
      screen.getByTestId("hero-avatar-2").firstElementChild,
    ).toHaveAttribute("style", expect.stringContaining("avatar-float"));
  });

  it("opens the editor at the avatar that was clicked", async () => {
    render(<AvatarCustomizer />);

    await userEvent.click(screen.getByTestId("hero-avatar-3"));
    expect(screen.getByTestId("avatar-editor-popover-3")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("hero-avatar-1"));
    expect(screen.getByTestId("avatar-editor-popover-1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("avatar-editor-popover-3"),
    ).not.toBeInTheDocument();
  });

  it("does not render selection rings inside the website editor", async () => {
    render(<AvatarCustomizer />);

    await userEvent.click(screen.getByTestId("hero-avatar-4"));

    expect(
      screen
        .getByTestId("avatar-editor-popover-4")
        .querySelector("[class~='ring-2']"),
    ).not.toBeInTheDocument();
  });
});
