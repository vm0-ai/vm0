import { describe, expect, it } from "vitest";
import "../../css/index.css";

function appendDesktopShell(): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "zero-app";
  shell.dataset.desktopShell = "true";
  shell.innerHTML = `
    <nav data-testid="shell-label">Sidebar</nav>
    <div class="zero-chat-bubble-user" data-testid="user-message">User message</div>
    <div class="zero-chat-bubble-assistant" data-testid="assistant-message">
      Assistant message
      <a href="/" data-testid="assistant-link">link text</a>
      <code data-testid="assistant-inline-code">inline code</code>
      <pre data-testid="assistant-code-block">code block</pre>
    </div>
    <input data-testid="composer-input" value="Composer text" />
    <textarea data-testid="notes-textarea">Notes text</textarea>
    <select data-testid="select-control"><option>Option text</option></select>
    <div contenteditable="true" data-testid="contenteditable-editor">Editor text</div>
    <div role="textbox" data-testid="textbox-role">Textbox role</div>
    <div class="zero-desktop-selectable" data-testid="copyable-region">Copyable region</div>
  `;
  document.body.appendChild(shell);
  return shell;
}

function getRequiredElement(root: ParentNode, testId: string): HTMLElement {
  const element = root.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing ${testId}`);
  }
  return element;
}

describe("desktop shell text selection stylesheet", () => {
  it("disables selection on the desktop app shell and restores it for content and editors", () => {
    const shell = appendDesktopShell();
    try {
      expect(getComputedStyle(shell).userSelect).toBe("none");

      for (const testId of [
        "user-message",
        "assistant-message",
        "assistant-link",
        "assistant-inline-code",
        "assistant-code-block",
        "composer-input",
        "notes-textarea",
        "select-control",
        "contenteditable-editor",
        "textbox-role",
        "copyable-region",
      ]) {
        expect(
          getComputedStyle(getRequiredElement(shell, testId)).userSelect,
        ).toBe("text");
      }
    } finally {
      shell.remove();
    }
  });

  it("does not change web app shell selection without the desktop marker", () => {
    const shell = document.createElement("div");
    shell.className = "zero-app";
    document.body.appendChild(shell);
    try {
      expect(getComputedStyle(shell).userSelect).not.toBe("none");
    } finally {
      shell.remove();
    }
  });
});
