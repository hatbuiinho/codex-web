/**
 * The desktop Files pane is rendered by the extracted app as a global React
 * surface. When a preview worker is recreated, that surface can briefly
 * repaint its ancestors as well. In the browser shell, keep those repaints
 * contained to the Files pane and display loading state inside the pane.
 */
const PANEL_ATTRIBUTE = "data-codex-web-files-panel";
const LOADING_ATTRIBUTE = "data-codex-web-files-loading";

function findFilesPanel(): HTMLElement | null {
  const filterInput = document.querySelector<HTMLInputElement>(
    'input[placeholder="Filter files..."]',
  );
  if (!filterInput) {
    return null;
  }

  let candidate: HTMLElement | null = filterInput.parentElement;
  while (candidate && candidate !== document.body) {
    const bounds = candidate.getBoundingClientRect();
    if (
      bounds.height > 240 &&
      bounds.width > 220 &&
      bounds.width < window.innerWidth * 0.6 &&
      bounds.right >= window.innerWidth - 4
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function installStyles(): void {
  if (document.getElementById("codex-web-files-panel-stability-style")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "codex-web-files-panel-stability-style";
  style.textContent = `
    [${PANEL_ATTRIBUTE}] {
      contain: layout paint style;
      isolation: isolate;
      transform: translateZ(0);
    }
    [${PANEL_ATTRIBUTE}] [${LOADING_ATTRIBUTE}] {
      align-items: center;
      background: color-mix(in srgb, #181818 90%, transparent);
      border-bottom: 1px solid #3e3e3e;
      color: #bdbdbd;
      display: flex;
      font: 12px ui-sans-serif, system-ui, sans-serif;
      gap: 8px;
      left: 0;
      padding: 8px 12px;
      pointer-events: none;
      position: absolute;
      right: 0;
      top: 0;
      z-index: 20;
    }
    [${PANEL_ATTRIBUTE}] [${LOADING_ATTRIBUTE}]::before {
      animation: codex-web-file-loading-spin .8s linear infinite;
      border: 2px solid #777;
      border-right-color: transparent;
      border-radius: 50%;
      content: "";
      height: 11px;
      width: 11px;
    }
    @keyframes codex-web-file-loading-spin { to { transform: rotate(360deg); } }
  `;
  document.head.append(style);
}

function hasLoadingFileState(): boolean {
  return /loading file/i.test(document.body.innerText);
}

function sync(): void {
  const panel = findFilesPanel();
  if (!panel) {
    return;
  }
  panel.setAttribute(PANEL_ATTRIBUTE, "true");
  const existing = panel.querySelector<HTMLElement>(`[${LOADING_ATTRIBUTE}]`);
  if (!hasLoadingFileState()) {
    existing?.remove();
    return;
  }
  if (existing) {
    return;
  }
  const loading = document.createElement("div");
  loading.setAttribute(LOADING_ATTRIBUTE, "true");
  loading.textContent = "Loading selected file…";
  panel.append(loading);
}

export function installFilesPanelStability(): void {
  const start = (): void => {
    installStyles();
    let scheduled = false;
    const scheduleSync = (): void => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        sync();
      });
    };
    new MutationObserver(scheduleSync).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.addEventListener("resize", scheduleSync);
    scheduleSync();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
