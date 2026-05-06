import { computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { orgModelProviders$ } from "../external/org-model-providers.ts";
import { personalModelProviders$ } from "../external/personal-model-providers.ts";

type ProviderTier = "personal" | "org";

interface ComposerModelProviders {
  /** Merged list, personal-tier items first when the switch is on. */
  providers: ModelProviderResponse[];
  /**
   * Tier annotation per provider id. `tiers.get(id)` returns `"personal"`
   * for user-tier rows, `"org"` for org-tier rows. Absence implies "org"
   * — defensive default for any straggler the picker might receive.
   *
   * Undefined when the `personalModelProvider` feature switch is off
   * for the caller — signals to the picker that NO tier sectioning
   * should be rendered (byte-for-byte unchanged behavior). When the
   * switch is on the field is always set, even if the user has no
   * personal rows yet (the picker then sees an all-"org" map).
   *
   * The Map is kept off `ModelProviderResponse` itself so the contract
   * type stays clean and non-tier-aware consumers (settings / schedule
   * editors) can keep reading `orgModelProviders$` directly without
   * widening their own picker call sites.
   */
  tiers: Map<string, ProviderTier> | undefined;
}

/**
 * Merged provider stream consumed by the chat composer model picker.
 *
 * Wave 3 of Epic #11868. When the `personalModelProvider` feature
 * switch is on for the caller, the user's personal-tier providers are
 * surfaced first, followed by org-tier providers. When the switch is
 * off, behavior is identical to today (`orgModelProviders$` only) —
 * the personal HTTP fetch is skipped to avoid the staff-only 404 round
 * trip the personal endpoint produces for non-eligible callers.
 *
 * Settings / schedule editor pickers continue to read
 * `orgModelProviders$` directly; this stream is composer-specific so a
 * non-eligible user opening the schedule editor never pays the personal
 * fetch cost.
 */
export const composerModelProviders$ = computed(
  async (get): Promise<ComposerModelProviders> => {
    const features = get(featureSwitch$);
    const personalEnabled =
      features?.[FeatureSwitchKey.PersonalModelProvider] ?? false;

    const org = await get(orgModelProviders$);
    if (!personalEnabled) {
      // Switch off: hand back an undefined `tiers` so the picker stays
      // on its flat per-type rendering — no tier sectioning, no per-row
      // default badges, identical to pre-#11868 behavior.
      return { providers: org.modelProviders, tiers: undefined };
    }

    const personal = await get(personalModelProviders$);
    const tiers = new Map<string, ProviderTier>();
    for (const p of personal.modelProviders) {
      tiers.set(p.id, "personal");
    }
    for (const p of org.modelProviders) {
      // Defensive: if the same id ever appeared in both lists (shouldn't,
      // since user-tier and org-tier rows have distinct userIds), the
      // personal tier wins — matches the resolver's user-first precedence.
      if (!tiers.has(p.id)) {
        tiers.set(p.id, "org");
      }
    }
    return {
      providers: [...personal.modelProviders, ...org.modelProviders],
      tiers,
    };
  },
);
