import { expect, test, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import JSZip from "jszip";
import { server } from "../../../mocks/server.ts";
import {
  downloadPresentationHtmlPptx,
  presentationSpeakerNotesFromHtml,
} from "../presentation-html-pptx-download.ts";

const contentTypesNs =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const packageRelationshipsNs =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const presentationNs =
  "http://schemas.openxmlformats.org/presentationml/2006/main";
const relationshipNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function minimalPptxBlob(
  slideNumbers: readonly number[] = [1, 2],
): Promise<Blob> {
  const zip = new JSZip();
  const slideRelationshipEntries = slideNumbers
    .map((slideNumber, index) => {
      return `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNumber}.xml"/>`;
    })
    .join("\n  ");
  const slideIdEntries = slideNumbers
    .map((_, index) => {
      return `    <p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`;
    })
    .join("\n");
  const slideContentTypeEntries = slideNumbers
    .map((slideNumber) => {
      return `  <Override PartName="/ppt/slides/slide${slideNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    })
    .join("\n");
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${contentTypesNs}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slideContentTypeEntries}
</Types>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${presentationNs}" xmlns:r="${relationshipNs}">
  <p:sldIdLst>
${slideIdEntries}
  </p:sldIdLst>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${packageRelationshipsNs}">
  ${slideRelationshipEntries}
</Relationships>`,
  );
  for (const slideNumber of slideNumbers) {
    zip.file(
      `ppt/slides/slide${String(slideNumber)}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${presentationNs}"><p:cSld/></p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${String(slideNumber)}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${packageRelationshipsNs}"/>`,
    );
  }
  return zip.generateAsync({ type: "blob" });
}

function presentationHtmlResponse(html: string) {
  return HttpResponse.text(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function isRequestedPresentationUrl(
  requestedUrl: string | null,
  fileUrl: string,
): boolean {
  if (!requestedUrl) {
    return false;
  }
  const actual = new URL(requestedUrl);
  const expected = new URL(fileUrl);
  return (
    actual.origin === expected.origin && actual.pathname === expected.pathname
  );
}

test("downloads presentation HTML as PPTX through an export iframe", async () => {
  const fileUrl = "https://demo-deck.sites.vm0.io";
  let presentationHtmlRequested = false;
  let downloadedBlob: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloadedBlob = blob as Blob;
    return "blob:pptx-download";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
    return;
  });
  server.use(
    http.get("/__vm0-dev-artifact-fetch", ({ request }) => {
      const requestUrl = new URL(request.url);
      if (requestUrl.searchParams.get("url") !== fileUrl) {
        return new HttpResponse(null, { status: 404 });
      }
      presentationHtmlRequested = true;
      return presentationHtmlResponse(`
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
  expect(exportFrame.srcdoc).toContain('"skipDownload":true');

  window.dispatchEvent(
    new MessageEvent("message", {
      source: exportFrame.contentWindow,
      data: {
        type: "vm0-presentation-pptx-export",
        status: "success",
        blob: await minimalPptxBlob(),
      },
    }),
  );

  await download;
  expect(exportFrame).not.toBeInTheDocument();
  expect(downloadedBlob).toBeInstanceOf(Blob);
});

test("extracts speaker notes from presentation HTML metadata in slide order", () => {
  expect(
    presentationSpeakerNotesFromHtml(`
      <!doctype html>
      <html>
        <body>
          <section class="slide" data-slide-id="intro"></section>
          <section class="slide" data-slide-id="closing"></section>
          <script type="application/json" id="vm0-deck-metadata">
            {
              "kind": "presentation-html",
              "slides": {
                "closing": { "speakerNotes": "Closing note" },
                "intro": { "speakerNotes": "Intro note" }
              }
            }
          </script>
        </body>
      </html>
    `),
  ).toStrictEqual([
    { slideNumber: 1, notes: "Intro note" },
    { slideNumber: 2, notes: "Closing note" },
  ]);
});

test("ignores malformed presentation metadata when extracting speaker notes", () => {
  expect(
    presentationSpeakerNotesFromHtml(`
      <!doctype html>
      <html>
        <body>
          <section class="slide" data-slide-id="intro"></section>
          <script type="application/json" id="vm0-deck-metadata">
            { not-json
          </script>
        </body>
      </html>
    `),
  ).toStrictEqual([{ slideNumber: 1, notes: "" }]);
});

test("injects presentation speaker notes into the downloaded PPTX blob", async () => {
  const fileUrl = "https://demo-deck.sites.vm0.io";
  let downloadedBlob: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloadedBlob = blob as Blob;
    return "blob:pptx-download";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
    return;
  });
  server.use(
    http.get("*", ({ request }) => {
      const requestUrl = new URL(request.url);
      const requestedUrl =
        requestUrl.pathname === "/__vm0-dev-artifact-fetch"
          ? requestUrl.searchParams.get("url")
          : request.url;
      if (
        requestUrl.hostname !== "demo-deck.sites.vm0.io" &&
        !isRequestedPresentationUrl(requestedUrl, fileUrl)
      ) {
        return new HttpResponse(null, { status: 404 });
      }
      return presentationHtmlResponse(`
        <!doctype html>
        <html>
          <body>
            <section data-vm0-slide data-slide-id="slide-1">
              <h1>First</h1>
            </section>
            <section data-vm0-slide data-slide-id="slide-2">
              <h1>Second</h1>
            </section>
            <script type="application/json" id="vm0-deck-metadata">
              {
                "kind": "presentation-html",
                "slides": {
                  "slide-1": { "speakerNotes": "First <note> & detail" },
                  "slide-2": { "speakerNotes": "Second note" }
                }
              }
            </script>
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

  window.dispatchEvent(
    new MessageEvent("message", {
      source: exportFrame.contentWindow,
      data: {
        type: "vm0-presentation-pptx-export",
        status: "success",
        blob: await minimalPptxBlob(),
      },
    }),
  );
  await download;

  if (!downloadedBlob) {
    throw new Error("PPTX was not downloaded");
  }
  const zip = await JSZip.loadAsync(downloadedBlob);
  await expect(
    zip.file("ppt/notesSlides/notesSlide1.xml")?.async("string"),
  ).resolves.toContain("First &lt;note&gt; &amp; detail");
  await expect(
    zip.file("ppt/notesSlides/notesSlide2.xml")?.async("string"),
  ).resolves.toContain("Second note");
  await expect(
    zip.file("ppt/slides/_rels/slide1.xml.rels")?.async("string"),
  ).resolves.toContain("notesSlide1.xml");
  await expect(
    zip.file("[Content_Types].xml")?.async("string"),
  ).resolves.toContain("/ppt/notesMasters/notesMaster1.xml");
  const presentationXml = await zip
    .file("ppt/presentation.xml")
    ?.async("string");
  expect(presentationXml?.indexOf("<p:sldIdLst>")).toBeGreaterThan(-1);
  expect(presentationXml?.indexOf("<p:notesMasterIdLst>")).toBeGreaterThan(-1);
  expect(
    presentationXml!.indexOf("<p:sldIdLst>") <
      presentationXml!.indexOf("<p:notesMasterIdLst>"),
  ).toBeTruthy();
  await expect(
    zip.file("ppt/notesMasters/_rels/notesMaster1.xml.rels")?.async("string"),
  ).resolves.toContain("relationships/theme");
});

test("maps speaker notes using presentation slide order instead of slide file numbers", async () => {
  const fileUrl = "https://demo-deck.sites.vm0.io";
  let downloadedBlob: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloadedBlob = blob as Blob;
    return "blob:pptx-download";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
    return;
  });
  server.use(
    http.get("*", ({ request }) => {
      const requestUrl = new URL(request.url);
      const requestedUrl =
        requestUrl.pathname === "/__vm0-dev-artifact-fetch"
          ? requestUrl.searchParams.get("url")
          : request.url;
      if (
        requestUrl.hostname !== "demo-deck.sites.vm0.io" &&
        !isRequestedPresentationUrl(requestedUrl, fileUrl)
      ) {
        return new HttpResponse(null, { status: 404 });
      }
      return presentationHtmlResponse(`
        <!doctype html>
        <html>
          <body>
            <section data-vm0-slide data-slide-id="slide-1"></section>
            <section data-vm0-slide data-slide-id="slide-2"></section>
            <script type="application/json" id="vm0-deck-metadata">
              {
                "kind": "presentation-html",
                "slides": {
                  "slide-1": { "speakerNotes": "First note" },
                  "slide-2": { "speakerNotes": "Second note" }
                }
              }
            </script>
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

  window.dispatchEvent(
    new MessageEvent("message", {
      source: exportFrame.contentWindow,
      data: {
        type: "vm0-presentation-pptx-export",
        status: "success",
        blob: await minimalPptxBlob([2, 5]),
      },
    }),
  );
  await download;

  if (!downloadedBlob) {
    throw new Error("PPTX was not downloaded");
  }
  const zip = await JSZip.loadAsync(downloadedBlob);
  await expect(
    zip.file("ppt/notesSlides/notesSlide2.xml")?.async("string"),
  ).resolves.toContain("First note");
  await expect(
    zip.file("ppt/notesSlides/notesSlide5.xml")?.async("string"),
  ).resolves.toContain("Second note");
});
