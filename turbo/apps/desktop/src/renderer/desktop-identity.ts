import type { DesktopIdentityInfo } from "../desktop-bridge";

const LEGACY_ZERO_IDENTITY: DesktopIdentityInfo = {
  product: "zero",
  brandName: "Zero",
  displayName: "Zero Computer Use",
};

export function currentDesktopIdentity(): DesktopIdentityInfo {
  return window.vm0DesktopIdentity ?? LEGACY_ZERO_IDENTITY;
}
