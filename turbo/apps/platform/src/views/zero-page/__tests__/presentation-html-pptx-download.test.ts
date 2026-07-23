import { Browser } from "happy-dom";
import { describe, expect, it } from "vitest";
import { buildPresentationHtmlPptxExportHtml } from "../presentation-html-pptx-download.ts";

async function executePresentationExportLayout(
  exportHtml: string,
): Promise<string> {
  const exportDocument = new DOMParser().parseFromString(
    exportHtml,
    "text/html",
  );
  const bootstrapScript = Array.from(exportDocument.scripts).at(-1);
  if (!bootstrapScript) {
    throw new Error("Presentation export bootstrap not found");
  }

  const converterBoundary = exportDocument.createElement("script");
  converterBoundary.textContent = `
    window.domToPptx = {
      exportToPptx: async (nodes) => {
        const report = document.createElement("output");
        report.id = "presentation-export-layout";
        report.textContent = nodes.map((node) => {
          const wrapper = node.parentElement;
          if (!(wrapper instanceof HTMLElement)) {
            return "missing-wrapper";
          }
          return [
            wrapper.dataset.layout,
            window.getComputedStyle(wrapper).display,
            wrapper.style.getPropertyValue("display") || "authored",
            wrapper.classList.contains("active"),
            wrapper.hasAttribute("hidden"),
            wrapper.hasAttribute("inert"),
            wrapper.getAttribute("aria-hidden"),
            window.getComputedStyle(node).display,
            node.style.getPropertyValue("display") || "authored",
          ].join(",");
        }).join("|");
        document.body.append(report);
        return new Blob(["test-pptx"]);
      },
    };
  `;
  bootstrapScript.before(converterBoundary);

  const browser = new Browser({
    settings: {
      disableJavaScriptFileLoading: true,
      enableJavaScriptEvaluation: true,
      handleDisabledFileLoadingAsSuccess: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  const page = browser.newPage();
  try {
    page.content = `<!doctype html>\n${exportDocument.documentElement.outerHTML}`;
    await page.waitUntilComplete();
    const report = page.mainFrame.document.getElementById(
      "presentation-export-layout",
    );
    if (!report) {
      throw new Error("Presentation export converter did not run");
    }
    return report.textContent ?? "";
  } finally {
    await browser.close();
  }
}

describe("buildPresentationHtmlPptxExportHtml", () => {
  it("materializes selected theme switcher defaults before removing deck scripts", async () => {
    const exportHtml = await buildPresentationHtmlPptxExportHtml({
      baseUrl: "https://presentation.example.test/index.html",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              :root {
                --bg:#FFFFFF;
                --accent:#7257E6;
                --s1:#FF6B4A;
                --s2:#AEE63E;
                --s3:#3FA9F5;
              }
            </style>
          </head>
          <body>
            <div class="slide" data-slide-id="slide-1">
              <div class="stage" data-vm0-slide>
                <h1 style="color:var(--accent)">Slide</h1>
              </div>
            </div>
            <script>
              var MONO={
                "Mauve Dusk":["#FAF7FB","#FFFFFF","#2B2533","#635B70","#ECE7F0",["#9C7BB8","#8AA0C9","#E0B6C9","#2B2533"]]
              };
              var VIB={
                "Prism":["#FFFFFF","#F7F7FA","#1A1726","#5C5870","#ECECF2",["#7257E6","#FF6B4A","#AEE63E","#3FA9F5"]]
              };
              var FONTS={
                "Fredoka / Quicksand":["Fredoka","Quicksand"]
              };
              var sp=document.getElementById('swPal'),sf=document.getElementById('swFont');
              sp.value='M:Mauve Dusk';sf.value='Fredoka / Quicksand';
              sp.onchange();sf.onchange();
            </script>
            <script id="vm0-deck-metadata" type="application/json">
              {"kind":"presentation-html","editProtocolVersion":1,"slides":{}}
            </script>
          </body>
        </html>
      `,
      options: {
        fileName: "deck.pptx",
        layout: "LAYOUT_WIDE",
        skipDownload: true,
        svgAsVector: true,
      },
      signal: AbortSignal.any([]),
    });
    const doc = new DOMParser().parseFromString(exportHtml, "text/html");
    const styleText = Array.from(doc.querySelectorAll("style"))
      .map((style) => {
        return style.textContent ?? "";
      })
      .join("\n");
    const scriptText = Array.from(doc.querySelectorAll("script"))
      .map((script) => {
        return script.textContent ?? "";
      })
      .join("\n");

    expect(doc.querySelector("base")?.getAttribute("href")).toBe(
      "https://presentation.example.test/index.html",
    );
    expect(
      doc.querySelector('[data-vm0-materialized-theme="true"]'),
    ).not.toBeNull();
    expect(styleText).toContain("--bg:#FAF7FB");
    expect(styleText).toContain("--accent:#9C7BB8");
    expect(styleText).toContain("--s1:#8AA0C9");
    expect(styleText).toContain("--s2:#E0B6C9");
    expect(styleText).toContain("--s3:#2B2533");
    expect(styleText).toContain("--fd:'Fredoka'");
    expect(styleText).toContain("--fb:'Quicksand'");
    expect(scriptText).not.toContain("var MONO");
    expect(scriptText).toContain("vm0-presentation-pptx-export");
    expect(scriptText).toContain("preserveBrowserTextLineBreaks(nodes)");
    expect(scriptText).not.toContain("resolveEmbeddableFonts");
  });

  it("prepares staged slides with complex backgrounds before exporting", async () => {
    const exportHtml = await buildPresentationHtmlPptxExportHtml({
      baseUrl: "https://presentation.example.test/index.html",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              :root { --bg: #f3f6fb; }
              body { margin: 0; background: #0f172a; }
              .slide {
                position: absolute;
                inset: 0;
                display: none;
                background: #0f172a;
              }
              .slide.active { display: flex; }
              .stage {
                position: relative;
                width: min(100vw, 177.7778vh);
                height: min(56.25vw, 100vh);
                background:
                  linear-gradient(rgba(21, 35, 58, 0.035) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(21, 35, 58, 0.035) 1px, transparent 1px),
                  radial-gradient(circle at 68% 42%, rgba(37, 99, 235, 0.08), transparent 34%),
                  var(--bg);
              }
            </style>
          </head>
          <body>
            <section class="slide active">
              <div class="stage">
                <h1>Slide</h1>
              </div>
            </section>
            <script id="vm0-deck-metadata" type="application/json">
              {"kind":"presentation-html","editProtocolVersion":1,"slides":{}}
            </script>
          </body>
        </html>
      `,
      options: {
        fileName: "deck.pptx",
        layout: "LAYOUT_WIDE",
        skipDownload: true,
        svgAsVector: true,
      },
      signal: AbortSignal.any([]),
    });
    const doc = new DOMParser().parseFromString(exportHtml, "text/html");
    const scriptText = Array.from(doc.querySelectorAll("script"))
      .map((script) => {
        return script.textContent ?? "";
      })
      .join("\n");

    expect(scriptText).toContain("normalizeSlideStages(nodes)");
    expect(scriptText).toContain(
      "await materializeComplexSlideBackgrounds(nodes)",
    );
    expect(scriptText.indexOf("normalizeSlideStages(nodes)")).toBeLessThan(
      scriptText.indexOf("window.domToPptx.exportToPptx"),
    );
    expect(
      scriptText.indexOf("await materializeComplexSlideBackgrounds(nodes)"),
    ).toBeLessThan(scriptText.indexOf("window.domToPptx.exportToPptx"));
  });

  it("preserves authored flex and grid layouts while activating slides", async () => {
    const exportHtml = await buildPresentationHtmlPptxExportHtml({
      baseUrl: "https://presentation.example.test/index.html",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              .slide { display: none; }
              .slide.active[data-layout="flex"] { display: flex; }
              .slide.active[data-layout="grid"] { display: grid; }
              [data-vm0-slide][data-layout="flex"] { display: flex; }
              [data-vm0-slide][data-layout="grid"] { display: grid; }
            </style>
          </head>
          <body>
            <section class="slide active" data-layout="flex">
              <div data-vm0-slide data-layout="flex">
                <h1>Flex slide</h1>
              </div>
            </section>
            <section
              class="slide"
              data-layout="grid"
              hidden
              inert
              aria-hidden="true"
              style="display: none !important"
            >
              <div data-vm0-slide data-layout="grid">
                <h1>Grid slide</h1>
              </div>
            </section>
          </body>
        </html>
      `,
      options: {
        fileName: "deck.pptx",
        layout: "LAYOUT_WIDE",
        skipDownload: true,
        svgAsVector: true,
      },
      signal: AbortSignal.any([]),
    });

    await expect(executePresentationExportLayout(exportHtml)).resolves.toBe(
      "flex,flex,authored,true,false,false,false,flex,authored|grid,grid,authored,true,false,false,false,grid,authored",
    );
  });
});
