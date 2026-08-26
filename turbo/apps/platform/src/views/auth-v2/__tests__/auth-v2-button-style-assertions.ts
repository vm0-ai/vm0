import { compile } from "tailwindcss";

interface IdentityEditPresentation {
  readonly borderRadius: string;
  readonly color: string;
  readonly height: string;
  readonly iconHeight: string;
  readonly iconWidth: string;
  readonly rowMinHeight: string;
  readonly width: string;
}

const buttonTheme = `
  @theme {
    --spacing: 0.25rem;
    --radius-sm: 0.25rem;
    --radius-lg: 0.5rem;
    --color-muted-foreground: rgb(100 110 120);
    --color-primary: rgb(130 140 150);
    --color-primary-foreground: rgb(160 170 180);
  }
  @tailwind utilities;
`;

export async function renderedIdentityEditPresentation(
  button: HTMLElement,
  signal: AbortSignal,
): Promise<IdentityEditPresentation> {
  const icon = button.querySelector("svg");
  const row = button.parentElement;
  if (!icon || !row) {
    throw new Error("Expected the identity edit button, icon, and preview row");
  }

  const compiler = await compile(buttonTheme);
  const styleElement = document.createElement("style");
  styleElement.textContent = compiler
    .build([...row.classList, ...button.classList])
    .replaceAll("var(--spacing)", "4px")
    .replaceAll("var(--radius-sm)", "4px")
    .replaceAll("var(--radius-lg)", "8px")
    .replaceAll("var(--color-muted-foreground)", "rgb(100 110 120)")
    .replaceAll("var(--color-primary)", "rgb(130 140 150)")
    .replaceAll("var(--color-primary-foreground)", "rgb(160 170 180)");
  document.head.append(styleElement);
  signal.addEventListener(
    "abort",
    () => {
      styleElement.remove();
    },
    { once: true },
  );

  const buttonStyle = getComputedStyle(button);
  const iconStyle = getComputedStyle(icon);
  return {
    borderRadius: buttonStyle.borderRadius,
    color: buttonStyle.color,
    height: buttonStyle.height,
    iconHeight: iconStyle.height,
    iconWidth: iconStyle.width,
    rowMinHeight: getComputedStyle(row).minHeight,
    width: buttonStyle.width,
  };
}
