"use client";

import React from "react";
import Footer from "../../components/Footer";
import Particles from "../../components/Particles";

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
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-light)",
        borderRadius: "12px",
        padding: "40px 32px",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        transition: "all 0.3s ease",
        transform: isHovered ? "translateY(-2px)" : "translateY(0)",
        position: "relative",
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

export default function PricingPageClient() {
  return (
    <>
      <Particles />

      {/* Hero Section */}
      <section className="hero-section" style={{ paddingBottom: "40px" }}>
        <div className="container">
          <div>
            <h1 className="hero-title">Pay for what you use, nothing more</h1>
            <p className="hero-description">
              Start free with your AI teammate. Scale when you&apos;re ready, no
              credit card required.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="section-spacing" style={{ paddingTop: 0 }}>
        <div className="container">
          <div style={{ marginBottom: "60px" }}>
            <div
              style={{
                marginBottom: "40px",
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "20px",
                maxWidth: "1200px",
                margin: "0 auto 40px",
              }}
            >
              {/* Free Plan */}
              <PricingCard
                title="Free"
                price="$0"
                period="/month"
                description="Get started with your AI teammate for free."
                features={[
                  "10,000 starter credits",
                  "1 concurrent run",
                  "Unlimited total agents",
                  "Bring your own LLM keys",
                  "Community support",
                ]}
                buttonText="Get started"
                buttonHref="/sign-up"
                buttonClassName="btn-secondary-large"
              />

              {/* Pro Plan */}
              <PricingCard
                title="Pro"
                price="$40"
                period="/month"
                description="More power and seamless collaboration for your team."
                features={[
                  "20,000 credits / month",
                  "2 concurrent runs",
                  "Unlimited total agents",
                  "Bring your own LLM keys",
                  "Credits rollover (1 month)",
                  "Email support",
                ]}
                buttonText="Start with Pro"
                buttonHref="/sign-up?plan=pro"
                buttonClassName="btn-primary-large"
              />

              {/* Team Plan */}
              <PricingCard
                title="Team"
                price="$200"
                period="/month"
                description="Scale fast with zero friction and full flexibility."
                features={[
                  "120,000 credits / month",
                  "5 concurrent runs",
                  "Unlimited total agents",
                  "Bring your own LLM keys",
                  "Credits rollover (1 month)",
                  "Priority support",
                ]}
                buttonText="Start with Team"
                buttonHref="/sign-up?plan=team"
                buttonClassName="btn-secondary-large"
              />
            </div>
          </div>

          {/* Pay as you go */}
          <div
            style={{
              background: "var(--card-bg)",
              border: "1px solid var(--border-light)",
              borderRadius: "12px",
              padding: "40px",
              marginTop: "20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "40px",
            }}
          >
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
                Need more credits?
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
                Top up anytime at{" "}
                <strong
                  style={{ color: "var(--text-primary)", fontWeight: 500 }}
                >
                  1,000 credits per $1
                </strong>
                . Set up auto-recharge so your agents never stop — when your
                balance drops below a threshold, credits are purchased
                automatically.
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
                per 1,000 credits
              </div>
            </div>
          </div>

          {/* Feature Comparison Table */}
          <div style={{ marginTop: "60px" }}>
            <h2
              style={{
                fontSize: "42px",
                fontWeight: 400,
                color: "var(--text-primary)",
                marginBottom: "60px",
                textAlign: "center",
                letterSpacing: "-0.5px",
              }}
            >
              Compare plans
            </h2>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "separate",
                  borderSpacing: 0,
                  fontSize: "15px",
                  fontWeight: 300,
                }}
              >
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
                      Features
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
                      Free
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
                  <TableSection title="Credits & Agents" />
                  <TableRow
                    feature="Credits per month"
                    description="Credits consumed by AI model usage across all agents"
                    free="10,000 starter"
                    pro="20,000"
                    team="120,000"
                  />
                  <TableRow
                    feature="Concurrent runs"
                    description="Number of agents that can run concurrently"
                    free="1"
                    pro="2"
                    team="5"
                  />
                  <TableRow
                    feature="Total agents"
                    description="Maximum number of agents you can create"
                    free="Unlimited"
                    pro="Unlimited"
                    team="Unlimited"
                  />
                  <TableRow
                    feature="Credits rollover"
                    description="Unused credits carry over to the next billing period"
                    free={false}
                    pro="1 month"
                    team="1 month"
                  />
                  <TableRow
                    feature="Credit top-up"
                    description="Purchase additional credits anytime at $1 per 1,000 credits"
                    free={false}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature="Auto-recharge"
                    description="Automatically purchase credits when balance falls below a threshold"
                    free={false}
                    pro={true}
                    team={true}
                  />

                  <TableSection title="Connectors & Integrations" />
                  <TableRow
                    feature="Connectors"
                    description="Connect your tools like Slack, GitHub, Notion, and more"
                    free="All connectors"
                    pro="All connectors"
                    team="All connectors"
                  />
                  <TableRow
                    feature="Bring your own LLM"
                    description="Use your own model provider API keys"
                    free={true}
                    pro={true}
                    team={true}
                  />

                  <TableSection title="Security & Compliance" />
                  <TableRow
                    feature="Sandboxed execution"
                    description="Firecracker microVMs with hardware-level KVM isolation"
                    free={true}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature="Full audit trail"
                    description="Agent HTTP/HTTPS traffic logged with SHA-256 integrity per run"
                    free={true}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature="No credential exposure"
                    description="Secrets injected at network layer, never visible to agent code"
                    free={true}
                    pro={true}
                    team={true}
                  />

                  <TableSection title="Collaboration" />
                  <TableRow
                    feature="Team members"
                    description="Number of people in your workspace"
                    free="Unlimited"
                    pro="Unlimited"
                    team="Unlimited"
                  />
                  <TableRow
                    feature="Per-member credit caps"
                    description="Set spending limits for individual team members"
                    free={false}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature="Auto-recharge"
                    description="Automatically purchase credits when balance falls below a threshold"
                    free={false}
                    pro={true}
                    team={true}
                  />

                  <TableSection title="Support" />
                  <TableRow
                    feature="Community support"
                    description="Access to Discord community and documentation"
                    free={true}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature="Email support"
                    description="Direct email support from the VM0 team"
                    free={false}
                    pro={true}
                    team={true}
                  />
                  <TableRow
                    feature="Priority support"
                    description="Dedicated support with faster response times"
                    free={false}
                    pro={false}
                    team={true}
                  />
                </tbody>
              </table>
            </div>
          </div>

          {/* FAQ Section */}
          <div style={{ marginTop: "120px", marginBottom: "80px" }}>
            <h2
              style={{
                fontSize: "42px",
                fontWeight: 400,
                color: "var(--text-primary)",
                marginBottom: "60px",
                textAlign: "center",
                letterSpacing: "-0.5px",
              }}
            >
              Frequently asked questions
            </h2>
            <div
              style={{
                display: "grid",
                gap: "12px",
              }}
            >
              <FAQItem
                question="What are credits?"
                answer="Credits are consumed when your agents use AI models. Different models consume credits at different rates. For example, a simple task might use a few credits, while a complex multi-step workflow uses more."
              />
              <FAQItem
                question="Can I change plans at any time?"
                answer="Yes! You can upgrade or downgrade your plan at any time. Changes take effect immediately, and we'll prorate charges accordingly."
              />
              <FAQItem
                question="What happens when I run out of credits?"
                answer="When your credits are depleted, your agents will stop running. You can purchase additional credits via auto-recharge, or upgrade to a higher plan for more monthly credits."
              />
              <FAQItem
                question="Do unused credits roll over?"
                answer="On the Free plan, starter credits don't expire but don't replenish. On Pro, unused credits roll over for 1 month. On Team, credits roll over for 1 month."
              />
              <FAQItem
                question="Can I bring my own model provider?"
                answer="Yes! All plans support bringing your own LLM API keys (Anthropic, etc.). When using your own keys, no VM0 credits are consumed for model usage."
              />
              <FAQItem
                question="How secure is VM0?"
                answer="Every agent run executes in an isolated Firecracker microVM with hardware-level KVM isolation. Credentials are injected at the network layer and never exposed to agent code. All agent HTTP/HTTPS traffic is logged with SHA-256 integrity per run."
              />
              <FAQItem
                question="Do you offer annual billing or discounts?"
                answer="Contact us to discuss volume pricing, annual billing discounts, and custom arrangements for your team."
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
        colSpan={4}
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
  free,
  pro,
  team,
}: {
  feature: string;
  description?: string;
  free: string | boolean;
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
        {renderCell(free)}
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
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-light)",
        borderRadius: "16px",
        padding: "24px 32px",
        transition: "border-color 0.2s ease",
        cursor: "pointer",
      }}
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
