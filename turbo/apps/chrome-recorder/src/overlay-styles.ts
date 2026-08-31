export const OVERLAY_STYLES = `
:host {
  all: initial;
}

.layer {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter,
    "Helvetica Neue", Arial, sans-serif;
  color: #0b0b0c;
}

.layer[data-mode="hidden"] {
  display: none;
}

[hidden] {
  display: none !important;
}

button {
  font: inherit;
  cursor: pointer;
  border: 0;
  background: none;
  color: inherit;
}

.panel {
  position: absolute;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  width: 360px;
  pointer-events: auto;
  background: #ffffff;
  border-radius: 16px;
  box-shadow:
    0 1px 2px rgba(11, 11, 12, 0.08),
    0 24px 48px -12px rgba(11, 11, 12, 0.28);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #6b6b70;
}

.brand-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff4f0a;
}

.source {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.source-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-origin {
  font-size: 12px;
  color: #6b6b70;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #f4f4f5;
  font-size: 13px;
  font-weight: 500;
  width: 100%;
  text-align: left;
}

.option[data-interactive="false"] {
  cursor: default;
  color: #6b6b70;
}

.option-value {
  font-size: 12px;
  font-weight: 600;
  color: #6b6b70;
}

.option[data-active="true"] .option-value {
  color: #ff4f0a;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.primary {
  flex: 1;
  padding: 11px 16px;
  border-radius: 10px;
  background: #0b0b0c;
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
}

.secondary {
  padding: 11px 14px;
  border-radius: 10px;
  background: #f4f4f5;
  font-size: 14px;
  font-weight: 500;
}

.notice {
  font-size: 12px;
  line-height: 1.45;
  color: #b3350a;
  background: #fff1ea;
  border-radius: 8px;
  padding: 9px 11px;
}

.notice[hidden] {
  display: none;
}

.blur-bar {
  position: absolute;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 999px;
  background: #0b0b0c;
  color: #ffffff;
  box-shadow: 0 20px 40px -12px rgba(11, 11, 12, 0.5);
  font-size: 13px;
}

.blur-hint {
  padding: 0 6px 0 8px;
  font-weight: 500;
  white-space: nowrap;
}

.blur-count {
  color: #a1a1a6;
}

.pill-button {
  padding: 7px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.pill-button[data-active="true"] {
  background: #ff4f0a;
}

.pill-button[disabled] {
  opacity: 0.4;
  cursor: default;
}

.pill-button.confirm {
  background: #ffffff;
  color: #0b0b0c;
  font-weight: 600;
}

.highlight {
  position: fixed;
  border: 2px dashed #ff4f0a;
  border-radius: 6px;
  background: rgba(255, 79, 10, 0.12);
  pointer-events: none;
  display: none;
}

.highlight[data-visible="true"] {
  display: block;
}

.countdown {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.countdown-value {
  font-size: 132px;
  font-weight: 700;
  line-height: 1;
  color: #ffffff;
  text-shadow: 0 12px 48px rgba(11, 11, 12, 0.55);
}

.controller {
  position: absolute;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 999px;
  background: rgba(11, 11, 12, 0.94);
  color: #ffffff;
  box-shadow: 0 20px 40px -12px rgba(11, 11, 12, 0.5);
}

.recording-dot {
  width: 10px;
  height: 10px;
  margin-left: 4px;
  border-radius: 50%;
  background: #ff3b30;
}

.controller[data-status="paused"] .recording-dot {
  background: #a1a1a6;
}

.elapsed {
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  font-weight: 600;
  min-width: 52px;
  text-align: center;
}
`;
