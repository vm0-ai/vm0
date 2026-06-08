"use client";

import { useEffect } from "react";
import {
  currentLandingAttributionContext,
  writeAcquisitionAttributionCookie,
} from "../../src/lib/adAttribution";

interface TermlyConsentState {
  readonly advertising?: boolean;
  readonly analytics?: boolean;
}

interface TermlyApi {
  getConsentState?: () => TermlyConsentState | undefined;
  on?: (
    event: "consent" | "initialized",
    handler: (data?: { consentState?: TermlyConsentState }) => void,
  ) => void;
}

function getTermly(): TermlyApi | undefined {
  return (window as unknown as { Termly?: TermlyApi }).Termly;
}

// Acquisition attribution is marketing/advertising data, so it is only
// persisted once the user has granted advertising consent. Termly drives this:
// EU is opt-in, US is opt-out (granted by default per the Termly config).
function hasAdvertisingConsent(state: TermlyConsentState | undefined): boolean {
  return Boolean(state?.advertising);
}

// Writes first-touch acquisition attribution to the shared `.vm0.ai` cookie,
// gated on Termly advertising consent. Mounted once in the root layout; the
// cookie is first-touch so re-runs (consent changes, navigation) are no-ops
// after the first successful write.
export function AttributionCapture() {
  useEffect(() => {
    const capture = (state?: TermlyConsentState): void => {
      const consent = state ?? getTermly()?.getConsentState?.();
      if (!hasAdvertisingConsent(consent)) {
        return;
      }
      writeAcquisitionAttributionCookie(
        currentLandingAttributionContext(),
        window.location.search,
      );
    };

    const tryRegister = (): boolean => {
      const termly = getTermly();
      if (!termly?.on) {
        return false;
      }
      termly.on("initialized", (data) => {
        capture(data?.consentState);
      });
      termly.on("consent", (data) => {
        capture(data?.consentState);
      });
      capture();
      return true;
    };

    if (tryRegister()) {
      return;
    }

    // Termly loads beforeInteractive but may not be ready on the first effect
    // tick; poll briefly until it is, then stop.
    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      if (tryRegister() || attempts >= 20) {
        window.clearInterval(interval);
      }
    }, 250);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
