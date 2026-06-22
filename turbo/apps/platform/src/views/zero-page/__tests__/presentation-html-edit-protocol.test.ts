import { describe, expect, it } from "vitest";
import { previewPresentationHtml } from "../presentation-html-edit-protocol.ts";

describe("previewPresentationHtml", () => {
  it("materializes theme switcher defaults before removing scripts", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
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
              <div class="stage">
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
              var paletteSelect=document.getElementById('swPal'),fontSelect=document.getElementById('swFont');
              paletteSelect.value='M:Mauve Dusk';fontSelect.value='Fredoka / Quicksand';
              paletteSelect.onchange();fontSelect.onchange();
            </script>
          </body>
        </html>
      `,
    });
    const doc = new DOMParser().parseFromString(previewHtml, "text/html");
    const injectedCss = Array.from(doc.querySelectorAll("style"))
      .map((style) => {
        return style.textContent ?? "";
      })
      .join("\n");

    expect(doc.querySelector("script")).toBeNull();
    expect(injectedCss).toContain("--bg:#FAF7FB");
    expect(injectedCss).toContain("--accent:#9C7BB8");
    expect(injectedCss).toContain("--s1:#8AA0C9");
    expect(injectedCss).toContain("--s2:#E0B6C9");
    expect(injectedCss).toContain("--s3:#2B2533");
    expect(injectedCss).toContain("--g0:#85699d");
    expect(injectedCss).toContain("--fd:'Fredoka'");
    expect(injectedCss).toContain("--fb:'Quicksand'");
  });

  it("normalizes nested slide stages to fill the preview frame", () => {
    const previewHtml = previewPresentationHtml({
      activeSlideId: "slide-1",
      html: `
        <!doctype html>
        <html>
          <head>
            <style>
              .slide { width: 100vw; height: 100vh; background: #111; }
              .stage { width: min(100vw, 177.7778vh); height: min(56.25vw, 100vh); margin: auto; }
            </style>
          </head>
          <body>
            <div class="slide" data-vm0-slide data-slide-id="slide-1">
              <div class="stage">
                <h1>Slide</h1>
              </div>
            </div>
          </body>
        </html>
      `,
    });
    const doc = new DOMParser().parseFromString(previewHtml, "text/html");
    const injectedCss = Array.from(doc.querySelectorAll("style"))
      .map((style) => {
        return style.textContent ?? "";
      })
      .join("\n");

    expect(injectedCss).toContain("[data-vm0-editor-stage] > .slide");
    expect(injectedCss).toContain("[data-vm0-editor-stage] > .slide > .stage");
    expect(injectedCss).toContain("box-shadow: none !important");
    expect(injectedCss).toContain("border-radius: 0 !important");
  });
});
