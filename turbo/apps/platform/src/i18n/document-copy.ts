import { i18n } from "./index.ts";

type BrowserUpgradeTarget =
  | "browser"
  | "chrome"
  | "chromium"
  | "ios"
  | "safari";

interface BrowserUpgradeCopy {
  readonly action: string;
  readonly description: string;
  readonly title: string;
}

function appBrandName(): "VM0" | "Okou" {
  const brandName = document.documentElement.dataset.appBrandName;
  if (brandName !== "VM0" && brandName !== "Okou") {
    throw new Error("Invalid app brand name");
  }
  return brandName;
}

function setMetaContent(selector: string, content: string): void {
  document.querySelector(selector)?.setAttribute("content", content);
}

function brandedBrowserUpgradeCopy(
  copy: BrowserUpgradeCopy,
): BrowserUpgradeCopy {
  return {
    ...copy,
    description: copy.description.replace(/Zero/gu, appBrandName()),
  };
}

function browserUpgradeTarget(): BrowserUpgradeTarget {
  switch (document.documentElement.dataset.browserUpgradeTarget) {
    case "chrome":
    case "chromium":
    case "ios":
    case "safari": {
      return document.documentElement.dataset.browserUpgradeTarget;
    }
    default: {
      return "browser";
    }
  }
}

function browserUpgradeCopy(target: BrowserUpgradeTarget): BrowserUpgradeCopy {
  switch (target) {
    case "chrome": {
      return brandedBrowserUpgradeCopy({
        action: i18n.t(($) => {
          return $.appShell.browserUpgrade.chrome.action;
        }),
        description: i18n.t(($) => {
          return $.appShell.browserUpgrade.chrome.description;
        }),
        title: i18n.t(($) => {
          return $.appShell.browserUpgrade.chrome.title;
        }),
      });
    }
    case "chromium": {
      return brandedBrowserUpgradeCopy({
        action: i18n.t(($) => {
          return $.appShell.browserUpgrade.chromium.action;
        }),
        description: i18n.t(($) => {
          return $.appShell.browserUpgrade.chromium.description;
        }),
        title: i18n.t(($) => {
          return $.appShell.browserUpgrade.chromium.title;
        }),
      });
    }
    case "ios": {
      return brandedBrowserUpgradeCopy({
        action: i18n.t(($) => {
          return $.appShell.browserUpgrade.ios.action;
        }),
        description: i18n.t(($) => {
          return $.appShell.browserUpgrade.ios.description;
        }),
        title: i18n.t(($) => {
          return $.appShell.browserUpgrade.ios.title;
        }),
      });
    }
    case "safari": {
      return brandedBrowserUpgradeCopy({
        action: i18n.t(($) => {
          return $.appShell.browserUpgrade.safari.action;
        }),
        description: i18n.t(($) => {
          return $.appShell.browserUpgrade.safari.description;
        }),
        title: i18n.t(($) => {
          return $.appShell.browserUpgrade.safari.title;
        }),
      });
    }
    case "browser": {
      return brandedBrowserUpgradeCopy({
        action: i18n.t(($) => {
          return $.appShell.browserUpgrade.browser.action;
        }),
        description: i18n.t(($) => {
          return $.appShell.browserUpgrade.browser.description;
        }),
        title: i18n.t(($) => {
          return $.appShell.browserUpgrade.browser.title;
        }),
      });
    }
  }
}

export function applyDocumentLocaleCopy(): void {
  if (document.documentElement.dataset.appHeadManaged !== "true") {
    const productDescription = i18n.t(($) => {
      return $.appShell.metadata.description;
    });
    const productTitle = i18n.t(($) => {
      return $.appShell.metadata.title;
    });

    setMetaContent('meta[name="description"]', productDescription);
    setMetaContent('meta[property="og:description"]', productDescription);
    setMetaContent('meta[property="og:image:alt"]', productTitle);
    setMetaContent('meta[property="og:title"]', productTitle);
    setMetaContent('meta[name="twitter:description"]', productDescription);
    setMetaContent('meta[name="twitter:title"]', productTitle);
  }

  const upgradeCopy = browserUpgradeCopy(browserUpgradeTarget());
  const title = document.getElementById("browser-upgrade-title");
  const description = document.getElementById("browser-upgrade-description");
  const action = document.getElementById("browser-upgrade-action");

  if (title) {
    title.textContent = upgradeCopy.title;
  }
  if (description) {
    description.textContent = upgradeCopy.description;
  }
  if (action) {
    action.textContent = upgradeCopy.action;
  }
}
