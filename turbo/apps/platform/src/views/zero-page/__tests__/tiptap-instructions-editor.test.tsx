import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TiptapInstructionsEditor } from "../tiptap-instructions-editor.tsx";

describe("tiptap instructions editor", () => {
  it("should not call onChange when editor initialises with content", async () => {
    const onChange = vi.fn();

    render(
      <TiptapInstructionsEditor
        initialContent={"# Hello\n\nThis is a **test** with formatting."}
        onChange={onChange}
      />,
    );

    // Wait for the editor to mount (the footer hint is always rendered)
    await waitFor(() => {
      expect(
        screen.getByText(
          "Edit the instructions directly to customize your agent's behavior.",
        ),
      ).toBeInTheDocument();
    });

    // The baseline extension should suppress the spurious onChange that
    // Tiptap fires when it parses the initial markdown content.
    expect(onChange).not.toHaveBeenCalled();
  });
});
