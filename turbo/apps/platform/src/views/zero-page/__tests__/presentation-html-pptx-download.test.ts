import { expect, test } from "vitest";
import { waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { downloadPresentationHtmlPptx } from "../presentation-html-pptx-download.ts";

test("downloads presentation HTML as PPTX through an export iframe", async () => {
  const fileUrl = "https://demo-deck.sites.vm0.io";
  let presentationHtmlRequested = false;
  server.use(
    http.get("/__vm0-dev-artifact-fetch", ({ request }) => {
      const requestUrl = new URL(request.url);
      if (requestUrl.searchParams.get("url") !== fileUrl) {
        return new HttpResponse(null, { status: 404 });
      }
      presentationHtmlRequested = true;
      return HttpResponse.html(`
        <!doctype html>
        <html>
          <head><title>Demo deck</title></head>
          <body>
            <section data-vm0-slide>
              <h1>Demo deck</h1>
            </section>
          </body>
        </html>
      `);
    }),
  );

  const download = downloadPresentationHtmlPptx({
    filename: "demo-deck.html",
    signal: AbortSignal.any([]),
    url: fileUrl,
  });

  const exportFrame = await waitFor(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[title="Presentation PPTX export"]',
    );
    expect(frame).not.toBeNull();
    return frame;
  });
  if (!exportFrame) {
    throw new Error("Presentation export iframe was not created");
  }
  expect(presentationHtmlRequested).toBeTruthy();
  expect(exportFrame).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-downloads",
  );
  expect(exportFrame.srcdoc).toContain("window.domToPptx.exportToPptx");
  expect(exportFrame.srcdoc).toContain("demo-deck.pptx");

  window.dispatchEvent(
    new MessageEvent("message", {
      source: exportFrame.contentWindow,
      data: {
        type: "vm0-presentation-pptx-export",
        status: "success",
      },
    }),
  );

  await download;
  expect(exportFrame).not.toBeInTheDocument();
});
