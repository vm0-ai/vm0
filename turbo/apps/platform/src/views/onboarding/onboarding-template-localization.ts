import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  type IllustrationTemplateItem,
  type PresentationTemplateItem,
  type VideoTemplateItem,
} from "@vm0/core";
import type { TFunction } from "i18next";
import enUSCommon from "../../i18n/locales/en-US/common.json";

const PRESENTATION_TITLES = enUSCommon.onboarding.templates.presentation;
const ILLUSTRATION_TITLES = enUSCommon.onboarding.templates.illustration;
const VIDEO_TITLES = enUSCommon.onboarding.templates.video;

function hasOwnKey<ObjectType extends object>(
  object: ObjectType,
  key: PropertyKey,
): key is keyof ObjectType {
  return Object.hasOwn(object, key);
}

export function localizedPresentationTemplates(
  t: TFunction<"common">,
): readonly PresentationTemplateItem[] {
  return PRESENTATION_TEMPLATE_PICKER_ITEMS.slice(0, 11).map((template) => {
    const slug = template.slug;
    if (!hasOwnKey(PRESENTATION_TITLES, slug)) {
      throw new Error(`Missing presentation template localization: ${slug}`);
    }
    return {
      ...template,
      title: t(($) => {
        return $.onboarding.templates.presentation[slug];
      }),
    };
  });
}

export function localizedIllustrationTemplates(
  t: TFunction<"common">,
): readonly IllustrationTemplateItem[] {
  return ILLUSTRATION_TEMPLATE_ITEMS.map((template) => {
    const slug = template.slug;
    if (!hasOwnKey(ILLUSTRATION_TITLES, slug)) {
      throw new Error(`Missing illustration template localization: ${slug}`);
    }
    return {
      ...template,
      title: t(($) => {
        return $.onboarding.templates.illustration[slug];
      }),
    };
  });
}

export function localizedVideoTemplates(
  t: TFunction<"common">,
): readonly VideoTemplateItem[] {
  return VIDEO_TEMPLATE_ITEMS.map((template) => {
    const slug = template.slug;
    if (!hasOwnKey(VIDEO_TITLES, slug)) {
      throw new Error(`Missing video template localization: ${slug}`);
    }
    return {
      ...template,
      title: t(($) => {
        return $.onboarding.templates.video[slug];
      }),
    };
  });
}
