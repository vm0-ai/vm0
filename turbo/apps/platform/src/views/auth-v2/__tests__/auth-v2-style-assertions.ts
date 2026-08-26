import { compile } from "tailwindcss";

interface CheckboxPresentation {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly borderRadius: string;
  readonly borderStyle: string;
  readonly borderWidth: string;
  readonly flexShrink: string;
  readonly height: string;
  readonly width: string;
}

const checkboxTheme = `
  @theme {
    --spacing: 0.25rem;
    --radius-md: 0.375rem;
    --color-border: rgb(10 20 30);
    --color-input: rgb(40 50 60);
    --color-primary: rgb(70 80 90);
    --color-foreground: rgb(100 110 120);
  }
  @tailwind utilities;
`;

export async function renderedCheckboxPresentation(
  checkbox: HTMLElement,
  signal: AbortSignal,
): Promise<CheckboxPresentation> {
  const compiler = await compile(checkboxTheme);
  const styleElement = document.createElement("style");
  styleElement.textContent = compiler
    .build([...checkbox.classList])
    .replaceAll("var(--spacing)", "4px")
    .replaceAll("var(--radius-md)", "6px")
    .replaceAll("var(--color-border)", "rgb(10 20 30)")
    .replaceAll("var(--color-input)", "rgb(40 50 60)")
    .replaceAll("var(--color-primary)", "rgb(70 80 90)")
    .replaceAll("var(--color-foreground)", "rgb(100 110 120)")
    .replaceAll("var(--tw-border-style)", "solid");
  document.head.append(styleElement);
  signal.addEventListener(
    "abort",
    () => {
      styleElement.remove();
    },
    { once: true },
  );

  const style = getComputedStyle(checkbox);
  return {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    borderRadius: style.borderRadius,
    borderStyle: style.borderStyle,
    borderWidth: style.borderWidth,
    flexShrink: style.flexShrink,
    height: style.height,
    width: style.width,
  };
}
