// @vitest-environment happy-dom

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
const mockAvatarSvgBody = Buffer.from(mockAvatarSvg);
let assetServer: Server;
let assetOrigin = "";

function setHappyDomUrl(url: string) {
  (
    window as typeof window & { happyDOM: { setURL(nextUrl: string): void } }
  ).happyDOM.setURL(url);
}

async function renderCustomizer() {
  const result = render(<AvatarCustomizer />);
  await waitForAvatarSvgCount(5);
  return result;
}

async function waitForAvatarSvgCount(count: number) {
  await waitFor(() => {
    expect(document.querySelectorAll("svg").length).toBeGreaterThanOrEqual(
      count,
    );
  });
}

describe("AvatarCustomizer", () => {
  beforeAll(async () => {
    assetServer = createServer((request, response) => {
      if (request.url?.startsWith("/assets/avatar-svg/")) {
        response.writeHead(200, {
          connection: "close",
          "content-length": mockAvatarSvgBody.byteLength,
          "content-type": "image/svg+xml",
        });
        response.end(mockAvatarSvgBody);
        return;
      }
      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve, reject) => {
      assetServer.once("error", reject);
      assetServer.listen(0, "127.0.0.1", () => {
        const address = assetServer.address() as AddressInfo;
        assetOrigin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  beforeEach(() => {
    setHappyDomUrl(`${assetOrigin}/`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      assetServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it("keeps the default hero avatar selected on first render", async () => {
    await renderCustomizer();

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
    await renderCustomizer();

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
    await renderCustomizer();

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

  it("keeps the idle floating animation on hero avatars", async () => {
    await renderCustomizer();

    expect(
      screen.getByTestId("hero-avatar-2").firstElementChild,
    ).toHaveAttribute("style", expect.stringContaining("avatar-float"));
  });

  it("opens the editor at the avatar that was clicked", async () => {
    await renderCustomizer();

    await userEvent.click(screen.getByTestId("hero-avatar-3"));
    expect(screen.getByTestId("avatar-editor-popover-3")).toBeInTheDocument();
    await waitForAvatarSvgCount(11);

    await userEvent.click(screen.getByTestId("hero-avatar-1"));
    expect(screen.getByTestId("avatar-editor-popover-1")).toBeInTheDocument();
    await waitForAvatarSvgCount(11);
    expect(
      screen.queryByTestId("avatar-editor-popover-3"),
    ).not.toBeInTheDocument();
  });

  it("does not render selection rings inside the website editor", async () => {
    await renderCustomizer();

    await userEvent.click(screen.getByTestId("hero-avatar-4"));
    await waitForAvatarSvgCount(11);

    expect(
      screen
        .getByTestId("avatar-editor-popover-4")
        .querySelector("[class~='ring-2']"),
    ).not.toBeInTheDocument();
  });
});
