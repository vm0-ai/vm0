import { describe, expect, it } from "vitest";

import "../../css/index.css";

function getRequiredElement(selector: string): HTMLElement {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element for selector: ${selector}`);
  }
  return element;
}

describe("memory page layout", () => {
  it("keeps the file list visible beside a wide markdown code block", () => {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.width = "760px";
    wrapper.innerHTML = `
      <section class="zero-card" style="display: flex; min-height: 420px; min-width: 0; flex: 1 1 0%; flex-direction: column; overflow: hidden;">
        <div style="display: flex; min-height: 0; min-width: 0; flex: 1 1 0%; flex-direction: row;">
          <div style="order: 1; display: flex; min-height: 0; min-width: 0; flex: 1 1 0%; flex-direction: column;">
            <div class="border-b border-border/70 px-4 text-xs font-medium text-muted-foreground" style="display: flex; height: 36px; flex-shrink: 0; align-items: center;">
              <span class="truncate">MEMORY.md</span>
            </div>
            <div aria-label="Memory content" class="bg-background px-4 py-3" style="min-height: 0; min-width: 0; flex: 1 1 0%; overflow: auto;">
              <div class="wmde-markdown min-w-0 max-w-full !bg-transparent !text-foreground text-sm">
                <pre><code>npx -p @vm0/cli zero agent edit $ZERO_AGENT_ID --instructions-file /tmp/${"very-long-segment-".repeat(16)}current-instructions.md</code></pre>
              </div>
            </div>
          </div>
          <aside class="border-l border-border/70 bg-muted/20" style="order: 2; display: flex; min-height: 0; width: 240px; flex-shrink: 0; flex-direction: column;">
            <div class="border-b border-border/70 px-3" style="display: flex; height: 36px; flex-shrink: 0; align-items: center; justify-content: space-between;">
              <span class="text-xs font-medium text-muted-foreground">Files</span>
              <span class="text-xs text-muted-foreground">2</span>
            </div>
            <div class="p-2" style="min-height: 0; flex: 1 1 0%; overflow: auto;">
              <button type="button" class="rounded-md px-2 py-1.5 text-left transition-colors bg-accent text-accent-foreground" style="display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px;">
                <span class="min-w-0 truncate text-xs">MEMORY.md</span>
                <span class="shrink-0 text-xs text-muted-foreground">900 B</span>
              </button>
            </div>
          </aside>
        </div>
      </section>
    `;
    document.body.appendChild(wrapper);

    try {
      const cardRect = getRequiredElement(".zero-card").getBoundingClientRect();
      const filePanelRect = getRequiredElement("aside").getBoundingClientRect();
      const codeBlock = getRequiredElement(".wmde-markdown pre");

      expect(filePanelRect.right).toBeLessThanOrEqual(cardRect.right);
      expect(filePanelRect.width).toBeGreaterThanOrEqual(230);
      expect(codeBlock.scrollWidth).toBeGreaterThan(codeBlock.clientWidth);
    } finally {
      wrapper.remove();
    }
  });
});
