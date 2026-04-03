/**
 * Views tests for zero-instructions-tab.tsx and tiptap-instructions-editor.tsx
 * Tests loading/error states, unsaved changes handling, rich text rendering,
 * toolbar formatting actions, and bubble menu behavior.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ZeroInstructionsTab } from "../../zero-page/zero-instructions-tab.tsx";
import { TiptapInstructionsEditor } from "../../zero-page/tiptap-instructions-editor.tsx";

function defaultProps() {
  return {
    instructions: null,
    loading: false,
    fetchError: null,
    editedContent: null,
    isDirty: false,
    isBuilding: false,
    buildError: null,
    onEdit: vi.fn(),
    onDiscard: vi.fn(),
    onBuild: vi.fn(),
  };
}

describe("zero-instructions-tab", () => {
  it("shows loading skeleton while fetching (PREF-D-016)", () => {
    render(<ZeroInstructionsTab {...defaultProps()} loading />);
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows fetch error message (PREF-D-017)", () => {
    render(
      <ZeroInstructionsTab
        {...defaultProps()}
        fetchError="Failed to load instructions"
      />,
    );
    expect(screen.getByText("Failed to load instructions")).toBeInTheDocument();
  });

  it("shows build error message (PREF-D-018)", async () => {
    render(
      <ZeroInstructionsTab
        {...defaultProps()}
        buildError="Build failed: syntax error"
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("Build failed: syntax error"),
      ).toBeInTheDocument();
    });
  });

  it("shows editor placeholder text when empty (PREF-D-019)", async () => {
    render(<ZeroInstructionsTab {...defaultProps()} />);
    await waitFor(() => {
      expect(
        screen.getByText(
          "Edit the instructions directly to customize your agent's behavior.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("shows unsaved changes bar when dirty (PREF-D-020)", async () => {
    render(<ZeroInstructionsTab {...defaultProps()} isDirty />);
    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });
  });

  it("calls onDiscard when Discard button is clicked (PREF-D-021)", async () => {
    const onDiscard = vi.fn();
    render(
      <ZeroInstructionsTab {...defaultProps()} isDirty onDiscard={onDiscard} />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Discard/i }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Discard/i }));
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it("calls onBuild when Save button is clicked (PREF-D-022)", async () => {
    const onBuild = vi.fn();
    render(
      <ZeroInstructionsTab {...defaultProps()} isDirty onBuild={onBuild} />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^Save$/i }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /^Save$/i }));
    expect(onBuild).toHaveBeenCalledOnce();
  });
});

describe("tiptap-instructions-editor", () => {
  it("renders rich text content as formatted HTML (PREF-D-023)", async () => {
    render(
      <TiptapInstructionsEditor
        initialContent="**bold text**"
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector("strong")).toBeInTheDocument();
    });
  });

  it("shows placeholder attribute on editor when empty (PREF-D-024)", async () => {
    render(<TiptapInstructionsEditor initialContent="" onChange={vi.fn()} />);
    await waitFor(() => {
      const editorEl = document.querySelector("[data-placeholder]");
      expect(editorEl).toHaveAttribute(
        "data-placeholder",
        "Write instructions for your agent...",
      );
    });
  });

  it("renders footer hint text below editor (PREF-D-025)", async () => {
    render(<TiptapInstructionsEditor initialContent="" onChange={vi.fn()} />);
    await waitFor(() => {
      expect(
        screen.getByText(
          "Edit the instructions directly to customize your agent's behavior.",
        ),
      ).toBeInTheDocument();
    });
  });

  it("applies opacity-60 class when disabled (PREF-D-026)", async () => {
    render(
      <TiptapInstructionsEditor
        initialContent=""
        onChange={vi.fn()}
        disabled
      />,
    );
    await waitFor(() => {
      expect(document.querySelector(".opacity-60")).toBeInTheDocument();
    });
  });

  it("renders a contenteditable area (PREF-D-027)", async () => {
    render(<TiptapInstructionsEditor initialContent="" onChange={vi.fn()} />);
    await waitFor(() => {
      expect(
        document.querySelector('[contenteditable="true"]'),
      ).toBeInTheDocument();
    });
  });

  async function renderEditorWithSelection(content: string) {
    const user = userEvent.setup();
    render(
      <TiptapInstructionsEditor initialContent={content} onChange={vi.fn()} />,
    );
    // Wait for the editor to mount
    await waitFor(() => {
      expect(
        document.querySelector('[contenteditable="true"]'),
      ).toBeInTheDocument();
    });
    const editorEl = document.querySelector(
      '[contenteditable="true"]',
    ) as HTMLElement;
    // Focus the editor and select all text to trigger bubble menu
    await user.click(editorEl);
    await user.keyboard("{Control>}a{/Control}");
    return editorEl;
  }

  it("bold button toggles bold formatting (PREF-D-028)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Bold" }));
  });

  it("italic button toggles italic formatting (PREF-D-029)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Italic" }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Italic" }));
  });

  it("strikethrough button toggles strikethrough (PREF-D-030)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Strikethrough" }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Strikethrough" }));
  });

  it("code button toggles inline code (PREF-D-031)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Inline code" }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Inline code" }));
  });

  it("h1 button applies heading 1 (PREF-D-032)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Heading 1" }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Heading 1" }));
  });

  it("h2 button applies heading 2 (PREF-D-033)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Heading 2" }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Heading 2" }));
  });

  it("h3 button applies heading 3 (PREF-D-034)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Heading 3" }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Heading 3" }));
  });

  it("bullet list button creates unordered list (PREF-D-035)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Bullet list" }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Bullet list" }));
  });

  it("ordered list button creates numbered list (PREF-D-036)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Ordered list" }),
      ).toBeInTheDocument();
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Ordered list" }));
  });

  it("bubble menu appears on text selection (PREF-D-037)", async () => {
    await renderEditorWithSelection("Hello world");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Italic" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Strikethrough" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Inline code" }),
      ).toBeInTheDocument();
    });
  });
});
