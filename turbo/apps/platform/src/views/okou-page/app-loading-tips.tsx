import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  appLoadingTip$,
  appLoadingTipsRef$,
} from "../../signals/app-loading-tips.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

function LoadingTip() {
  const { t } = useTranslation();
  const tip = useGet(appLoadingTip$);
  const loadingTipsRef = useSet(appLoadingTipsRef$);
  const text = t(
    ($) => {
      return $.appLoading.tips[tip];
    },
    {
      supportEmail: "contact@okou.ai",
    },
  );

  return (
    <div
      ref={loadingTipsRef}
      aria-live="off"
      className="absolute top-full left-1/2 mt-6 w-[min(24rem,calc(100vw-3rem))] -translate-x-1/2 text-center text-sm leading-relaxed text-muted-foreground"
    >
      <p
        key={tip}
        className="m-0 motion-safe:transition-opacity motion-safe:duration-300 motion-safe:starting:opacity-0"
      >
        {tip === "support" ? (
          <a
            href="mailto:contact@okou.ai"
            className="underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground focus-visible:text-foreground"
          >
            {text}
          </a>
        ) : (
          text
        )}
      </p>
    </div>
  );
}

export function AppLoadingTips() {
  const features = useGet(featureSwitch$);
  return features[FeatureSwitchKey.AppLoadingTips] ? <LoadingTip /> : null;
}
