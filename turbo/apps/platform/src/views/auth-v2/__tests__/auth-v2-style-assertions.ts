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

interface FocusedElementPresentation {
  readonly boxShadow: string;
}

interface AuthV2ActionContrast {
  readonly link: number;
  readonly primary: number;
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

const focusedElementTheme = `
  @theme {
    --color-ring: rgb(10 20 30);
  }
  @tailwind utilities;
`;

const authV2ActionTheme = `
  @custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
  @theme {
    --color-card: rgb(255 255 255);
    --color-gray-50: rgb(243 245 248);
    --color-gray-950: rgb(20 23 29);
    --color-primary: rgb(237 78 1);
    --color-primary-500: rgb(244 162 136);
    --color-primary-600: rgb(235 136 104);
    --color-primary-900: rgb(208 50 0);
    --color-primary-950: rgb(92 41 24);
  }
  @tailwind utilities;
`;

function colorChannels(color: string): readonly [number, number, number] {
  const channels = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length !== 3) {
    throw new Error(`Unable to read color channels from ${color}`);
  }
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
}

function relativeLuminance(color: string): number {
  const channels = colorChannels(color).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

export async function renderedAuthV2ActionContrast(
  primaryAction: HTMLElement,
  linkAction: HTMLElement,
  surface: HTMLElement,
  theme: "dark" | "light",
  signal: AbortSignal,
): Promise<AuthV2ActionContrast> {
  const compiler = await compile(authV2ActionTheme);
  const styleElement = document.createElement("style");
  const effectiveRestingColorClasses = (element: HTMLElement): string[] => {
    const candidates = [...element.classList]
      .map((className) => {
        if (className.startsWith("dark:")) {
          return theme === "dark" ? className.slice("dark:".length) : null;
        }
        return className;
      })
      .filter((className): className is string => {
        return (
          className !== null &&
          !className.includes(":") &&
          !className.includes("[") &&
          (className.startsWith("bg-") || className.startsWith("text-"))
        );
      });
    const properties = new Set<string>();
    return candidates.reverse().filter((className) => {
      const property = className.startsWith("bg-") ? "background" : "color";
      if (properties.has(property)) {
        return false;
      }
      properties.add(property);
      return true;
    });
  };
  const primaryProbe = document.createElement("div");
  const linkProbe = document.createElement("div");
  const surfaceProbe = document.createElement("div");
  primaryProbe.classList.add(...effectiveRestingColorClasses(primaryAction));
  linkProbe.classList.add(...effectiveRestingColorClasses(linkAction));
  surfaceProbe.classList.add(...effectiveRestingColorClasses(surface));
  document.body.append(primaryProbe, linkProbe, surfaceProbe);
  const restingColorClasses = [
    ...primaryProbe.classList,
    ...linkProbe.classList,
    ...surfaceProbe.classList,
  ];
  styleElement.textContent = [
    compiler.build(restingColorClasses),
    `[data-theme="dark"] {
      --color-card: rgb(37 37 39);
      --color-gray-50: rgb(25 25 27);
      --color-gray-950: rgb(232 233 237);
      --color-primary-900: rgb(255 148 110);
      --color-primary-950: rgb(254 213 199);
    }`,
  ].join("\n");
  document.head.append(styleElement);
  signal.addEventListener(
    "abort",
    () => {
      styleElement.remove();
      primaryProbe.remove();
      linkProbe.remove();
      surfaceProbe.remove();
    },
    { once: true },
  );

  const primaryStyle = getComputedStyle(primaryProbe);
  const linkStyle = getComputedStyle(linkProbe);
  const surfaceStyle = getComputedStyle(surfaceProbe);
  const primaryColor = primaryStyle.color;
  const primaryBackground = primaryStyle.backgroundColor;
  const linkColor = linkStyle.color;
  const surfaceBackground = surfaceStyle.backgroundColor;
  if (!primaryColor || !primaryBackground || !linkColor || !surfaceBackground) {
    throw new Error(
      `Missing rendered action color: ${JSON.stringify({
        linkColor,
        primaryBackground,
        primaryColor,
        surfaceBackground,
      })}`,
    );
  }
  return {
    link: contrastRatio(linkColor, surfaceBackground),
    primary: contrastRatio(primaryColor, primaryBackground),
  };
}

export async function renderedFocusedElementPresentation(
  element: HTMLElement,
  signal: AbortSignal,
): Promise<FocusedElementPresentation> {
  const compiler = await compile(focusedElementTheme);
  const styleElement = document.createElement("style");
  styleElement.textContent = [
    "* { box-shadow: none; }",
    compiler.build([...element.classList]),
  ].join("\n");
  document.head.append(styleElement);
  signal.addEventListener(
    "abort",
    () => {
      styleElement.remove();
    },
    { once: true },
  );

  return { boxShadow: getComputedStyle(element).boxShadow };
}

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
