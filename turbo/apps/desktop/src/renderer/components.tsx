import type { ReactNode } from "react";
import { zeroAvatarDataUrl } from "./zero-avatar";
import type { DesktopComputerUseState } from "../computer-use-types";
import { previewValue } from "./format";

export type HostStatus = DesktopComputerUseState["host"]["status"];

export const STATUS_LABELS = {
  offline: "Offline",
  connecting: "Connecting",
  online: "Online",
  recovering: "Recovering",
  unauthenticated: "Signed out",
  needs_organization: "Select workspace",
  disabled: "Disabled",
  error: "Error",
} as const satisfies Record<HostStatus, string>;

export const RECOVERY_PHASE_LABELS = {
  start: "Start",
  heartbeat: "Heartbeat",
  command_poll: "Command poll",
} as const satisfies Record<
  NonNullable<DesktopComputerUseState["host"]["recovery"]>["phase"],
  string
>;

export function IconButton({
  children,
  disabled,
  icon,
  onClick,
  tone = "secondary",
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly onClick: () => void;
  readonly tone?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      className={`button button-${tone}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function CheckboxRow({
  checked,
  disabled,
  meta,
  onChange,
  subtitle,
  title,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly meta: string;
  readonly onChange: (checked: boolean) => void;
  readonly subtitle: string;
  readonly title: string;
}) {
  return (
    <label className="checkbox-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
      />
      <span className="checkbox-row-copy">
        <span className="row-title">{title}</span>
        <span className="row-meta">{subtitle}</span>
      </span>
      <span className="checkbox-row-meta">{meta}</span>
    </label>
  );
}

export function Panel({
  children,
  title,
  icon,
}: {
  readonly children: ReactNode;
  readonly title: string;
  readonly icon?: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { readonly status: HostStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function KeyValueList({
  emptyLabel,
  value,
}: {
  readonly emptyLabel: string;
  readonly value: Record<string, unknown>;
}) {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return <div className="compact-empty">{emptyLabel}</div>;
  }
  return (
    <dl className="key-value-list">
      {entries.map(([key, entry]) => {
        return (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{previewValue(entry)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function ZeroFace({
  className,
  size,
}: {
  readonly className?: string;
  readonly size: number;
}) {
  return (
    <span
      className={`zero-face${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img src={zeroAvatarDataUrl} alt="" draggable={false} />
    </span>
  );
}
