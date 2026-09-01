import { screen, waitFor } from "@testing-library/react";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { isoFromNowMs, mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("export page", () => {
  it("shows the export contents and a localized cooldown error", async () => {
    mockNow(context.signal);
    context.mocks.api(userExportContract.get, ({ respond }) => {
      return respond(200, {
        job: {
          id: "00000000-0000-4000-8000-000000000001",
          status: "completed",
          createdAt: isoFromNowMs(-60 * 60 * 1000),
          completedAt: isoFromNowMs(0),
          expiresAt: isoFromNowMs(36 * 60 * 60 * 1000),
          downloadUrl: "https://example.com/export.zip",
          error: null,
        },
        canExport: true,
        nextExportAt: null,
      });
    });
    context.mocks.api(userExportContract.post, ({ respond }) => {
      return respond(429, {
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "Export cooldown active",
        },
      });
    });

    detachedSetupPage({ context, path: "/export" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Export data" }),
      ).toBeInTheDocument();
      expect(document.title).toBe("Export data | VM0");
    });
    expect(
      screen.getByText("Workflow SKILL.md instructions and files"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The download link expires in 1d 12h."),
    ).toBeInTheDocument();

    click(screen.getByText("Export again"));

    await waitFor(() => {
      expect(
        screen.getByText("You can export once every 24 hours."),
      ).toBeInTheDocument();
    });
  });

  it("shows export controls in Brazilian Portuguese", async () => {
    document.documentElement.lang = "pt-BR";
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    mockNow(context.signal);
    context.mocks.api(userExportContract.get, ({ respond }) => {
      return respond(200, {
        job: {
          id: "00000000-0000-4000-8000-000000000001",
          status: "completed",
          createdAt: isoFromNowMs(-60 * 60 * 1000),
          completedAt: isoFromNowMs(0),
          expiresAt: isoFromNowMs(36 * 60 * 60 * 1000),
          downloadUrl: "https://example.com/export.zip",
          error: null,
        },
        canExport: true,
        nextExportAt: null,
      });
    });

    detachedSetupPage({ context, path: "/export" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: "Exportar dados",
        }),
      ).toBeInTheDocument();
      expect(document.title).toBe("Export data | VM0");
    });
    expect(
      screen.getByText("Instruções e arquivos SKILL.md dos fluxos de trabalho"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("O link para download expira em 1 dia 12 h."),
    ).toBeInTheDocument();
    expect(screen.getByText("Baixar exportação")).toBeInTheDocument();
  });
});
