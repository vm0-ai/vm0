import { describe, expect, it } from "vitest";
import { buildPresentationHtmlPptxExportHtml } from "../presentation-html-pptx-download.ts";

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
  });
});
