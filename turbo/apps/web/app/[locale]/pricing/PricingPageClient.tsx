"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Footer } from "../../components/Footer";
import { Particles } from "../../components/Particles";

function PricingCard({
  title,
  price,
  period,
  description,
  features,
  buttonText,
  buttonHref,
  buttonClassName,
}: {
  title: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  buttonText: string;
  buttonHref: string;
  buttonClassName: string;
}) {
  const [isHovered, setIsHovered] = React.useState(false);

  return (
    <div
      className="pricing-card"
      style={{
        transform: isHovered ? "translateY(-2px)" : "translateY(0)",
      }}
      onMouseEnter={() => {
        return setIsHovered(true);
      }}
      onMouseLeave={() => {
        return setIsHovered(false);
      }}
    >
      <h2
        style={{
          fontSize: "18px",
          fontWeight: 600,
          fontFamily: '"Fira Mono", monospace',
          color: "#ed4e01",
          marginBottom: "16px",
          letterSpacing: "0.5px",
          textTransform: "uppercase",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontSize: "42px",
          fontWeight: 300,
          color: "var(--text-primary)",
          letterSpacing: "-1.5px",
          lineHeight: 1,
          marginBottom: "8px",
        }}
      >
        {price}
        <span
          style={{
            fontSize: "15px",
            fontWeight: 300,
            color: "var(--text-muted)",
            letterSpacing: "0.2px",
            marginLeft: "8px",
          }}
        >
          {period}
        </span>
      </div>
      <p
        style={{
          fontSize: "15px",
          fontWeight: 300,
          color: "var(--text-secondary)",
          lineHeight: 1.6,
          marginBottom: "32px",
          letterSpacing: "0.1px",
        }}
      >
        {description}
      </p>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 32px 0",
          fontSize: "14px",
          fontWeight: 300,
          color: "var(--text-secondary)",
        }}
      >
        {features.map((feature, index) => {
          return (
            <li
              key={index}
              style={{
                marginBottom: "12px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                letterSpacing: "0.1px",
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ed4e01"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{feature}</span>
            </li>
          );
        })}
      </ul>
      <a
        href={buttonHref}
        style={{
          display: "block",
          width: "100%",
          textAlign: "center",
          marginTop: "auto",
          textDecoration: "none",
          fontSize: "15px",
        }}
        className={buttonClassName}
      >
        {buttonText}
      </a>
    </div>
  );
}

export function PricingPageClient() {
  const t = useTranslations("pricing");

  return (
    <>
      <Particles />

      {/* Hero Section */}
      <section className="hero-section" style={{ paddingBottom: "40px" }}>
        <div className="container">
          <div>
            <h1 className="hero-title">{t("heroTitle")}</h1>
            <p className="hero-description">{t("heroDescription")}</p>
          </div>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="section-spacing" style={{ paddingTop: 0 }}>
        <div className="container">
          <div style={{ marginBottom: "60px" }}>
            <div className="pricing-cards-grid">
              {/* Pro Plan */}
              <PricingCard
                title="Pro"
                price="$20"
                period={t("perMonth")}
                description={t("pro.description")}
                features={[
                  t("pro.features.credits"),
                  t("pro.features.concurrentRuns"),
                  t("pro.features.unlimitedAgents"),
                  t("pro.features.bringOwnLLM"),
                  t("pro.features.voiceInput"),
                  t("pro.features.creditsRollover"),
                  t("pro.features.emailSupport"),
                ]}
                buttonText={t("pro.buttonText")}
                buttonHref="/sign-up?plan=pro"
                buttonClassName="btn-primary-large"
              />

              {/* Team Plan */}
              <PricingCard
                title="Team"
                price="$200"
                period={t("perMonth")}
                description={t("team.description")}
                features={[
                  t("team.features.credits"),
                  t("team.features.concurrentRuns"),
                  t("team.features.unlimitedAgents"),
                  t("team.features.bringOwnLLM"),
                  t("team.features.voiceInput"),
                  t("team.features.creditsRollover"),
                  t("team.features.prioritySupport"),
                ]}
                buttonText={t("team.buttonText")}
                buttonHref="/sign-up?plan=team"
                buttonClassName="btn-secondary-large"
              />
            </div>
          </div>

          {/* Pay as you go */}
          <div className="pricing-topup">
            <div>
              <h2
                style={{
                  fontSize: "24px",
                  fontWeight: 400,
                  color: "var(--text-primary)",
                  marginBottom: "8px",
                  letterSpacing: "-0.3px",
                }}
              >
                {t("needMoreCredits")}
              </h2>
              <p
                style={{
                  fontSize: "15px",
                  fontWeight: 300,
                  color: "var(--text-secondary)",
                  lineHeight: 1.6,
                  margin: 0,
                  maxWidth: "600px",
                }}
              >
                {t("topUpDescription")}{" "}
                <strong
                  style={{ color: "var(--text-primary)", fontWeight: 500 }}
                >
                  {t("topUpRate")}
                </strong>
                . {t("topUpAutoRecharge")}
              </p>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "4px",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  fontSize: "36px",
                  fontWeight: 300,
                  color: "var(--text-primary)",
                  letterSpacing: "-1px",
                  lineHeight: 1,
                }}
              >
                $1
              </div>
              <div
                style={{
                  fontSize: "13px",
                  fontWeight: 300,
                  color: "var(--text-muted)",
                }}
              >
                {t("perCredits")}
              </div>
            </div>
          </div>

          {/* Feature Comparison Table */}
          <div style={{ marginTop: "60px" }}>
            <h2
              className="pricing-section-title"
              style={{ marginBottom: "60px" }}
            >
              {t("comparePlans")}
            </h2>
            <div style={{ overflowX: "auto" }}>
              <table className="pricing-table">
                <thead>
                  <tr>
                    <th
                      style={{
                        textAlign: "left",
                        padding: "24px 20px",
                        background: "transparent",
                        color: "var(--text-primary)",
                        fontSize: "16px",
                        fontWeight: 600,
                        borderBottom: "1px solid var(--border-light)",
                      }}
                    >
                      {t("featuresHeader")}
                    </th>
                    <th
                      style={{
                        textAlign: "center",
                        padding: "24px 20px",
                        background: "transparent",
                        color: "var(--text-primary)",
                        fontSize: "16px",
                        fontWeight: 600,
                        borderBottom: "1px solid var(--border-light)",
                      }}
                    >
                      Pro
                    </th>
                    <th
                      style={{
                        textAlign: "center",
                        padding: "24px 20px",
                        background: "transparent",
                        color: "var(--text-primary)",
                        fontSize: "16px",
                        fontWeight: 600,
                        borderBottom: "1px solid var(--border-light)",
                      }}
                    >
                      Team
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <TableSection title={t("sections.creditsAndAgents")} />
                  <TableRow
                    feature={t("tableFeatures.creditsPerMonth")}
                    description={t("tableFeatures.creditsPerMonthDesc")}
                    pro={t("tableValues.20k")}
                    team={t("tableValues.120k")}
                  />
                  <TableRow
                    feature={t("tableFeatures.concurrentRuns")}
                    description={t("tableFeatures.concurrentRunsDesc")}
                    pro="2"
                    team="10"
                  />
                  <TableRow
                    feature={t("tableFeatures.totalAgents")}
                    description={t("tableFeatures.totalAgentsDesc")}
                    pro={t("tableValues.unlimited")}
                    team={t("tableValues.unlimited")}
                  />
                  <TableRow
                    feature={t("tableFeatures.creditTopUp")}
                    description={t("tableFeatures.creditTopUpDesc")}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature={t("tableFeatures.autoRecharge")}
                    description={t("tableFeatures.autoRechargeDesc")}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature={t("tableFeatures.scheduledRuns")}
                    description={t("tableFeatures.scheduledRunsDesc")}
                    pro={true}
                    team={true}
                  />

                  <TableSection
                    title={t("sections.connectorsAndIntegrations")}
                  />
                  <TableRow
                    feature={t("tableFeatures.connectors")}
                    description={t("tableFeatures.connectorsDesc")}
                    pro={t("tableValues.allConnectors")}
                    team={t("tableValues.allConnectors")}
                  />
                  <TableRow
                    feature={t("tableFeatures.multiChannel")}
                    description={t("tableFeatures.multiChannelDesc")}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature={t("tableFeatures.bringOwnLLM")}
                    description={t("tableFeatures.bringOwnLLMDesc")}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature={t("tableFeatures.voiceInput")}
                    description={t("tableFeatures.voiceInputDesc")}
                    pro={true}
                    team={true}
                  />

                  <TableSection title={t("sections.securityAndCompliance")} />
                  <TableRow
                    feature={t("tableFeatures.sandboxedExecution")}
                    description={t("tableFeatures.sandboxedExecutionDesc")}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature={t("tableFeatures.fullAuditTrail")}
                    description={t("tableFeatures.fullAuditTrailDesc")}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature={t("tableFeatures.noCredentialExposure")}
                    description={t("tableFeatures.noCredentialExposureDesc")}
                    pro={true}
                    team={true}
                  />

                  <TableSection title={t("sections.collaboration")} />
                  <TableRow
                    feature={t("tableFeatures.teamMembers")}
                    description={t("tableFeatures.teamMembersDesc")}
                    pro={t("tableValues.unlimited")}
                    team={t("tableValues.unlimited")}
                  />
                  <TableRow
                    feature={t("tableFeatures.memberUsage")}
                    description={t("tableFeatures.memberUsageDesc")}
                    pro={true}
                    team={true}
                  />

                  <TableSection title={t("sections.support")} />
                  <TableRow
                    feature={t("tableFeatures.communitySupport")}
                    description={t("tableFeatures.communitySupportDesc")}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature={t("tableFeatures.emailSupport")}
                    description={t("tableFeatures.emailSupportDesc")}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature={t("tableFeatures.prioritySupport")}
                    description={t("tableFeatures.prioritySupportDesc")}
                    pro={false}
                    team={true}
                  />
                </tbody>
              </table>
            </div>
          </div>

          {/* FAQ Section */}
          <div className="pricing-faq-section">
            <h2
              className="pricing-section-title"
              style={{ marginBottom: "60px" }}
            >
              {t("faq.title")}
            </h2>
            <div
              style={{
                display: "grid",
                gap: "12px",
              }}
            >
              <FAQItem
                question={t("faq.whatAreCredits")}
                answer={t("faq.whatAreCreditsAnswer")}
              />
              <FAQItem
                question={t("faq.freeTrial")}
                answer={t("faq.freeTrialAnswer")}
              />
              <FAQItem
                question={t("faq.changePlans")}
                answer={t("faq.changePlansAnswer")}
              />
              <FAQItem
                question={t("faq.runOutOfCredits")}
                answer={t("faq.runOutOfCreditsAnswer")}
              />
              <FAQItem
                question={t("faq.doCreditsRollOver")}
                answer={t("faq.doCreditsRollOverAnswer")}
              />
              <FAQItem
                question={t("faq.upgradeCredits")}
                answer={t("faq.upgradeCreditsAnswer")}
              />
              <FAQItem
                question={t("faq.bringOwnModel")}
                answer={t("faq.bringOwnModelAnswer")}
              />
              <FAQItem
                question={t("faq.howSecure")}
                answer={t("faq.howSecureAnswer")}
              />
              <FAQItem
                question={t("faq.annualBilling")}
                answer={t("faq.annualBillingAnswer")}
              />
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}

function TableSection({ title }: { title: string }) {
  return (
    <tr>
      <td
        colSpan={3}
        style={{
          padding: "32px 20px 16px 20px",
          fontSize: "15px",
          fontWeight: 600,
          color: "var(--text-primary)",
          background: "transparent",
          borderTop: "1px solid var(--border-light)",
        }}
      >
        {title}
      </td>
    </tr>
  );
}

function TableRow({
  feature,
  description,
  pro,
  team,
}: {
  feature: string;
  description?: string;
  pro: string | boolean;
  team: string | boolean;
}) {
  const renderCell = (value: string | boolean) => {
    if (typeof value === "boolean") {
      return value ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ed4e01"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ margin: "0 auto", display: "block" }}
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: "14px" }}>—</span>
      );
    }
    return value;
  };

  return (
    <tr>
      <td
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        <div style={{ color: "var(--text-secondary)" }}>{feature}</div>
        {description && (
          <div
            style={{
              fontSize: "13px",
              color: "#827D77",
              marginTop: "4px",
              lineHeight: 1.4,
            }}
          >
            {description}
          </div>
        )}
      </td>
      <td
        style={{
          padding: "16px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {renderCell(pro)}
      </td>
      <td
        style={{
          padding: "16px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {renderCell(team)}
      </td>
    </tr>
  );
}

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [isExpanded, setIsExpanded] = React.useState(false);

  return (
    <div
      className="pricing-faq-item"
      onClick={() => {
        return setIsExpanded(!isExpanded);
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-light)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-light)";
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "16px",
        }}
      >
        <h3
          style={{
            fontSize: "18px",
            fontWeight: 400,
            color: "var(--text-primary)",
            margin: 0,
            letterSpacing: "-0.2px",
          }}
        >
          {question}
        </h3>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-secondary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transition: "transform 0.3s ease",
            transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
      {isExpanded && (
        <p
          style={{
            fontSize: "15px",
            fontWeight: 300,
            color: "var(--text-secondary)",
            lineHeight: 1.7,
            margin: "16px 0 0 0",
            paddingTop: "16px",
            borderTop: "1px solid var(--border-light)",
          }}
        >
          {answer}
        </p>
      )}
    </div>
  );
}
