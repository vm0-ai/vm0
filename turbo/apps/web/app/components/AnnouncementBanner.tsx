"use client";

import { useEffect } from "react";
import { Link } from "../../navigation";
import { useTranslations } from "next-intl";

const BANNER_HEIGHT = 32; // px

export default function AnnouncementBanner() {
  const t = useTranslations("banner");

  useEffect(() => {
    // Set CSS variable for navbar offset
    document.documentElement.style.setProperty(
      "--announcement-banner-height",
      `${BANNER_HEIGHT}px`,
    );
  }, []);

  return (
    <div className="announcement-banner">
      <div className="announcement-banner-content">
        <div className="announcement-banner-text">
          <span className="announcement-banner-message">{t("message")}</span>
          <Link
            href="/blog/posts/vm0-public-beta"
            className="announcement-banner-link"
          >
            {t("link")}
          </Link>
        </div>
      </div>
    </div>
  );
}
