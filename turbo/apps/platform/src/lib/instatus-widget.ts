const INSTATUS_SCRIPT_URL =
  "https://api.dashboard.instatus.com/widget?host=status.okou.ai&code=02c0ef5a&locale=en";
const INSTATUS_SCRIPT_INTEGRITY =
  "sha384-YU7+0Wj4uP1wkywaN92wj9+XhrCKLPHapq5vtxjnjEQU401q3xFgN4JNkMWcBHOW";

export function initInstatusWidget(): void {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname !== "app.vm0.ai" && hostname !== "app.okou.ai") {
    return;
  }

  const script = document.createElement("script");
  script.src = INSTATUS_SCRIPT_URL;
  script.integrity = INSTATUS_SCRIPT_INTEGRITY;
  script.crossOrigin = "anonymous";
  script.defer = true;
  document.body.appendChild(script);
}
