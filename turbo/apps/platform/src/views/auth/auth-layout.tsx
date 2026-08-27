import type { ReactNode } from "react";
import type { AuthBrandContext } from "../../signals/auth.ts";
import { AuthShell } from "./auth-shell.tsx";

const CLERK_CSS = `
/* Remove shadows from Clerk components */
.cl-card,
.cl-rootBox,
.cl-main,
.cl-cardBox,
[class*="cl-"] > div {
  box-shadow: none !important;
}

/* Card styles */
.cl-card,
.cl-rootBox > .cl-card,
[class*="cl-card"] {
  background-color: hsl(var(--card)) !important;
  border: 1px solid hsl(var(--border)) !important;
  border-radius: 0.75rem !important;
  box-shadow: none !important;
}

/* Logo styles - height 24px */
.cl-logoImage {
  height: 24px !important;
  width: auto !important;
}

/* Logo container - total height 32px */
.cl-logoBox,
.cl-card [class*="logoBox"] {
  height: 32px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0 !important;
  margin-top: 10px !important;
}

/* Header title - Text-lg/Medium 18-28 */
.cl-headerTitle,
.cl-card h1,
.cl-card [class*="headerTitle"],
.cl-card [class*="Header"] h1,
.cl-headerTitle * {
  font-size: 18px !important;
  line-height: 28px !important;
  font-weight: 500 !important;
  color: hsl(var(--foreground)) !important;
}

/* Subtitle - Sm-regular 14-20 */
.cl-headerSubtitle,
.cl-card [class*="headerSubtitle"] {
  font-size: 14px !important;
  line-height: 20px !important;
  font-weight: 400 !important;
  color: hsl(var(--muted-foreground)) !important;
}

/* Form field labels - 14/20 medium */
.cl-formFieldLabel,
.cl-card label,
.cl-card [class*="formFieldLabel"],
.cl-formFieldLabel * {
  font-size: 14px !important;
  line-height: 20px !important;
  font-weight: 500 !important;
  color: hsl(var(--foreground)) !important;
}

/* Input field styles.
   The glob uses :not(:has(...)) to target only leaf-level wrappers - it excludes
   any parent container that itself contains a nested formFieldInput element (e.g. a
   section wrapper that groups multiple fields). plain input[type] selectors cover
   fields that Clerk renders without a wrapper div. The :not([class*="ShowPassword"])
   excludes the eye-toggle button/icon, whose class name also contains
   "formFieldInput" (cl-formFieldInputShowPasswordButton) - applying input height,
   border, and transition to it causes the icon to flicker/jump on click. The
   [type="checkbox"] exclusion preserves Clerk's native checkbox dimensions and
   checked surface. */
.cl-formFieldInput:not([type="checkbox"]),
.cl-card [class*="formFieldInput"]:not([class*="ShowPassword"]):not([type="checkbox"]):not(:has([class*="formFieldInput"])),
.cl-card input[type="text"],
.cl-card input[type="email"],
.cl-card input[type="password"] {
  height: 36px !important;
  background-color: hsl(var(--input)) !important;
  border: 1px solid hsl(var(--border)) !important;
  border-radius: 0.5rem !important;
  color: hsl(var(--foreground)) !important;
  transition:
    border-color 0.2s,
    box-shadow 0.2s !important;
  box-shadow: none !important;
}

/* Dark mode: --border (gray-200 = #2F2F32) and --input (gray-200) are nearly
   identical to the card background (gray-100 = #252527) - borders are invisible.
   Use --gray-400 (#434550, labelled "stronger border" in the design system). */
[data-theme="dark"] .cl-formFieldInput:not([type="checkbox"]),
[data-theme="dark"] .cl-card [class*="formFieldInput"]:not([class*="ShowPassword"]):not([type="checkbox"]):not(:has([class*="formFieldInput"])),
[data-theme="dark"] .cl-card input[type="text"],
[data-theme="dark"] .cl-card input[type="email"],
[data-theme="dark"] .cl-card input[type="password"] {
  border-color: hsl(var(--gray-400)) !important;
}

/* Checkbox containers must not inherit input wrapper border/height */
.cl-formFieldCheckboxInput,
.cl-formFieldCheckbox,
.cl-formFieldCheckboxWrapper {
  border: none !important;
  height: auto !important;
  box-shadow: none !important;
  border-radius: 0 !important;
}

/* Input focus state. Exclude ShowPassword button - its class matches
   [class*="formFieldInput"] but focusing it on click would draw a primary-color
   border that transitions in/out, producing the flicker reported in #10462. */
.cl-formFieldInput:not([type="checkbox"]):focus,
.cl-formFieldInput input:not([data-input-otp]):not([type="checkbox"]):focus,
.cl-card input:not([data-input-otp]):not([type="checkbox"]):focus,
.cl-card [class*="formFieldInput"]:not([class*="ShowPassword"]):not([type="checkbox"]):focus,
.cl-card [class*="formFieldInput"]:not([class*="ShowPassword"]) input:not([data-input-otp]):not([type="checkbox"]):focus {
  border: 1px solid hsl(var(--primary)) !important;
  box-shadow: 0 0 0 3px hsl(var(--primary) / 0.1) !important;
  outline: none !important;
}

/* Dark mode: re-assert primary (orange) focus color for text/email inputs.
   The --gray-400 base override ties at (0,3,1) specificity with the general focus
   rule; adding [data-theme="dark"] bumps this to (0,4,1) and guarantees the win.
   Note: password wrapper already works via the base focus rule - do NOT add
   :focus-within here or the wrapper + inner input both get borders (double ring). */
[data-theme="dark"] .cl-card input[type="text"]:focus,
[data-theme="dark"] .cl-card input[type="email"]:focus {
  border-color: hsl(var(--primary)) !important;
  box-shadow: 0 0 0 3px hsl(var(--primary) / 0.1) !important;
  outline: none !important;
}

/* Placeholder color */
.cl-formFieldInput::placeholder,
.cl-formFieldInput input::placeholder,
.cl-card input::placeholder {
  color: hsl(var(--muted-foreground)) !important;
}

/* Primary page action - match the neutral-dark shared page button while
   removing Clerk's gradients and borders (exclude social buttons). */
.cl-formButtonPrimary,
button[type="submit"]:not(.cl-socialButtonsBlockButton),
[data-localization-key="formButtonPrimary"],
.cl-formButtonPrimary > * {
  background-image: none !important;
  background: hsl(var(--foreground)) !important;
  border: none !important;
  box-shadow: none !important;
  color: hsl(var(--background)) !important;
}

/* Button hover state (exclude social buttons) */
.cl-formButtonPrimary:hover,
button[type="submit"]:not(.cl-socialButtonsBlockButton):hover,
[data-localization-key="formButtonPrimary"]:hover {
  background-image: none !important;
  background: var(--color-foreground-hover) !important;
  box-shadow: none !important;
}

.cl-formButtonPrimary:active,
button[type="submit"]:not(.cl-socialButtonsBlockButton):active,
[data-localization-key="formButtonPrimary"]:active {
  background: var(--color-foreground-pressed) !important;
}

/* Remove pseudo elements (exclude social buttons) */
.cl-formButtonPrimary::before,
.cl-formButtonPrimary::after,
button[type="submit"]:not(.cl-socialButtonsBlockButton)::before,
button[type="submit"]:not(.cl-socialButtonsBlockButton)::after {
  display: none !important;
  background-image: none !important;
}

/* Social buttons (Google login) - add border and set text color */
button[class*="socialButtonsBlockButton"],
button[class*="cl-socialButtons"],
.cl-socialButtonsBlockButton,
div[class*="socialButtons"] button {
  height: 36px !important;
  background-color: transparent !important;
  background-image: none !important;
  border-width: 1px !important;
  border-style: solid !important;
  border-color: var(--color-border) !important;
  border-radius: 0.5rem !important;
  color: var(--color-foreground) !important;
  box-shadow: none !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 0.5rem !important;
  transition: background-color 0.2s !important;
}

/* Social buttons hover state */
button[class*="socialButtonsBlockButton"]:hover,
.cl-socialButtonsBlockButton:hover {
  background-color: var(--color-muted) !important;
}

/* Social button text color */
button[class*="socialButtonsBlockButton"] [class*="text" i],
.cl-socialButtonsBlockButton [class*="text" i],
button[class*="socialButtons"] [class*="text" i],
button[class*="socialButtonsBlockButton"] [class*="label" i],
.cl-socialButtonsBlockButton [class*="label" i] {
  color: var(--color-foreground) !important;
}

/* Preserve OAuth provider icons, which Clerk may render with svg/img or background images. */
button[class*="socialButtonsBlockButton"] [class*="icon" i],
.cl-socialButtonsBlockButton [class*="icon" i],
button[class*="socialButtonsBlockButton"] svg,
.cl-socialButtonsBlockButton svg,
button[class*="socialButtonsBlockButton"] img,
.cl-socialButtonsBlockButton img {
  display: inline-block !important;
  flex-shrink: 0 !important;
  background-position: center !important;
  background-repeat: no-repeat !important;
  background-size: contain !important;
  height: 16px !important;
  opacity: 1 !important;
  width: 16px !important;
}

/* Footer background - use card color */
.cl-footer,
.cl-footerAction,
[class*="cl-footer"]:not(.cl-card):not(.cl-main):not(.cl-header),
[class*="footerAction"] {
  background-color: hsl(var(--card)) !important;
  background: hsl(var(--card)) !important;
}

/* Footer action text - use foreground for sufficient contrast in dark mode */
.cl-footerActionText,
[class*="footerActionText"] {
  color: hsl(var(--foreground)) !important;
}

/* Footer action link - primary color */
.cl-footerActionLink,
[class*="footerActionLink"] {
  color: hsl(var(--primary)) !important;
  text-decoration: none !important;
}

.cl-footerActionLink:hover,
[class*="footerActionLink"]:hover {
  color: hsl(var(--primary) / 0.9) !important;
  text-decoration: none !important;
}

/* The discoverable passkey action is rendered by Clerk as a footer link even
   though it is a peer of the other sign-in methods. Match the standard outline
   button without changing other footer or recovery links. */
.cl-footerAction__usePasskey {
  width: 100% !important;
}

.cl-footerActionLink__usePasskey {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 100% !important;
  height: 36px !important;
  border-width: 0.7px !important;
  border-style: solid !important;
  border-color: hsl(var(--gray-400)) !important;
  border-radius: 0.5rem !important;
  background-color: hsl(var(--background)) !important;
  color: hsl(var(--foreground)) !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  text-decoration: none !important;
  transition: background-color 0.2s !important;
}

.cl-footerActionLink__usePasskey:hover {
  background-color: var(--color-state-hover) !important;
  color: hsl(var(--foreground)) !important;
}

.cl-footerActionLink__usePasskey:active {
  background-color: var(--color-state-pressed) !important;
}

/* OTP/Verification Code Input Boxes - Match cli-auth style */
.cl-otpCodeFieldInput {
  height: 36px !important;
  width: 36px !important;
  background-color: hsl(var(--input)) !important;
  border: 1px solid hsl(var(--border)) !important;
  border-radius: 0.5rem !important;
  color: hsl(var(--foreground)) !important;
  font-size: 16px !important;
  font-weight: 500 !important;
  text-align: center !important;
}

/* OTP Input Focus State */
.cl-otpCodeFieldInput[data-focus-within="true"] {
  border-color: hsl(var(--primary)) !important;
  box-shadow: 0 0 0 3px hsl(var(--primary) / 0.1) !important;
}

/* OTP caret color */
.cl-otpCodeFieldInput[data-focus-within="true"] > div > div {
  background-color: hsl(var(--foreground)) !important;
}

/* "Didn't receive a code" text color */
.cl-formResendCodeLink,
[class*="formResendCode"],
[class*="resendCode"],
.cl-card [class*="alternativeMethodsBlockButton"],
button[class*="alternativeMethodsBlockButton"] {
  color: hsl(var(--muted-foreground)) !important;
}

/* Email address display on verification screens */
.cl-identityPreviewText,
[class*="identityPreview"] [class*="text"],
.cl-card [class*="userPreview"] {
  color: hsl(var(--muted-foreground)) !important;
}

/* Keep resend link primary color */
.cl-formResendCodeLink a,
[class*="formResendCode"] a,
a[class*="resendCode"] {
  color: hsl(var(--primary)) !important;
}

/* Legal consent checkbox label links (Terms of Service, Privacy Policy) */
.cl-formFieldCheckboxLabel a {
  color: hsl(var(--primary)) !important;
}

/* Legal consent checkbox - preserve Clerk's checkmark on the platform checked surface */
.cl-card input[type="checkbox"],
.cl-formFieldCheckboxInput input[type="checkbox"] {
  -webkit-appearance: none;
  appearance: none;
  outline: none !important;
  width: 16px !important;
  height: 16px !important;
  min-width: 16px !important;
  border: 1.5px solid hsl(var(--foreground) / 0.35) !important;
  border-radius: 3px !important;
  background-color: transparent !important;
  cursor: pointer !important;
  flex-shrink: 0 !important;
}

.cl-card input[type="checkbox"]:checked,
.cl-formFieldCheckboxInput input[type="checkbox"]:checked {
  background-color: hsl(var(--primary)) !important;
  border-color: hsl(var(--primary)) !important;
}

.cl-card input[type="checkbox"]:hover,
.cl-formFieldCheckboxInput input[type="checkbox"]:hover {
  border-color: hsl(var(--primary)) !important;
}
`;

interface AuthLayoutProps {
  authBrand: AuthBrandContext;
  children: ReactNode;
}

export function AuthLayout({ authBrand, children }: AuthLayoutProps) {
  return (
    <>
      <style suppressHydrationWarning>{CLERK_CSS}</style>
      <AuthShell authBrand={authBrand}>{children}</AuthShell>
    </>
  );
}
