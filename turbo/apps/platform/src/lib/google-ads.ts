import { nowDate } from "./time.ts";

const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";

type GoogleTag = (...args: unknown[]) => void;

type GoogleAdsWindow = Window & {
  dataLayer?: unknown[];
  gtag?: GoogleTag;
};

export function initGoogleAds(): void {
  const hostname = window.location.hostname.toLowerCase();
  const isProductionHost =
    hostname === "vm0.ai" ||
    hostname.endsWith(".vm0.ai") ||
    hostname === "okou.ai" ||
    hostname.endsWith(".okou.ai");
  if (!isProductionHost) {
    return;
  }

  const googleAdsWindow: GoogleAdsWindow = window;
  const dataLayer = googleAdsWindow.dataLayer ?? [];
  googleAdsWindow.dataLayer = dataLayer;
  const gtag: GoogleTag = (...args) => {
    dataLayer.push(args);
  };
  googleAdsWindow.gtag = gtag;
  gtag("js", nowDate());
  gtag("config", "AW-18144854014");
  gtag("config", "AW-18407336975");

  const script = document.createElement("script");
  script.async = true;
  script.src = GOOGLE_TAG_SCRIPT_URL;
  document.head.appendChild(script);
}
