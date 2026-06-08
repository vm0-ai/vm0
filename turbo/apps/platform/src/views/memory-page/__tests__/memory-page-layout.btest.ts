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

  it("keeps update cards at their content height inside the scrolling timeline", () => {
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.height = "220px";
    wrapper.style.width = "760px";
    wrapper.innerHTML = `
      <div aria-label="Memory updates" style="display: flex; min-height: 0; flex: 1 1 0%; flex-direction: column; gap: 16px; overflow: auto; padding-bottom: 8px;">
        <section class="zero-card shrink-0" style="display: flex; height: 140px; flex-shrink: 0; flex-direction: column; overflow: hidden;">
          <header style="border-bottom: 1px solid hsl(var(--border)); padding: 12px 16px;">
            <h2 style="font-size: 14px; font-weight: 600;">Wednesday, June 3, 2026</h2>
            <p style="margin-top: 4px; font-size: 14px; line-height: 20px;">Zero learned a new development preference.</p>
          </header>
          <div style="display: flex; flex-direction: column; gap: 8px; padding: 12px 16px;">
            <div style="height: 40px; border: 1px solid hsl(var(--border)); border-radius: 6px;"></div>
          </div>
        </section>
        <section class="zero-card shrink-0" style="display: flex; height: 140px; flex-shrink: 0; flex-direction: column; overflow: hidden;">
          <header style="border-bottom: 1px solid hsl(var(--border)); padding: 12px 16px;">
            <h2 style="font-size: 14px; font-weight: 600;">Sunday, May 31, 2026</h2>
            <p style="margin-top: 4px; font-size: 14px; line-height: 20px;">Zero updated existing memory files.</p>
          </header>
          <div style="display: flex; flex-direction: column; gap: 8px; padding: 12px 16px;">
            <div style="height: 40px; border: 1px solid hsl(var(--border)); border-radius: 6px;"></div>
          </div>
        </section>
        <section class="zero-card shrink-0" style="display: flex; height: 460px; flex-shrink: 0; flex-direction: column; overflow: hidden;">
          <header style="border-bottom: 1px solid hsl(var(--border)); padding: 12px 16px;">
            <h2 style="font-size: 14px; font-weight: 600;">Thursday, May 21, 2026</h2>
            <p style="margin-top: 4px; font-size: 14px; line-height: 20px;">Zero learned several repo-specific workflows.</p>
          </header>
          <div style="display: flex; flex-direction: column; gap: 8px; padding: 12px 16px;">
            ${Array.from({ length: 8 }, () => {
              return '<div style="height: 40px; border: 1px solid hsl(var(--border)); border-radius: 6px;"></div>';
            }).join("")}
          </div>
        </section>
      </div>
    `;
    document.body.appendChild(wrapper);

    try {
      const scroller = getRequiredElement('[aria-label="Memory updates"]');
      const firstCard = getRequiredElement(
        '[aria-label="Memory updates"] .zero-card:nth-of-type(1)',
      );
      const secondCard = getRequiredElement(
        '[aria-label="Memory updates"] .zero-card:nth-of-type(2)',
      );
      const thirdCard = getRequiredElement(
        '[aria-label="Memory updates"] .zero-card:nth-of-type(3)',
      );

      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      expect(getComputedStyle(firstCard).flexShrink).toBe("0");
      expect(firstCard.getBoundingClientRect().height).toBeGreaterThan(130);
      expect(secondCard.getBoundingClientRect().height).toBeGreaterThan(130);
      expect(thirdCard.getBoundingClientRect().height).toBeGreaterThan(450);
    } finally {
      wrapper.remove();
    }
  });
});
