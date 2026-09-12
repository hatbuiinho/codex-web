import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";
import { compactLargeContext, type ThreadManager } from "./thread-context";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    }
  | {
      type: "bridge-ping";
      sentAt: number;
    };

type MainToRendererMessage =
  | { type: "bridge-ready" }
  | { type: "bridge-reset"; reason: string }
  | { type: "bridge-event"; sequence: number; message: MainToRendererMessage }
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "bridge-pong";
      sentAt: number;
    };

const RECONNECT_DELAY_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type StatsigGateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type ElectronShimState = {
  recoverIpcSession?: () => Promise<void>;
  prepareThreadPrompt?: (manager: ThreadManager, threadId: string) => Promise<void>;
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onSidebarOpenChanged?: (open: boolean) => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
  overrideAdapter?: {
    getGateOverride?: (
      evaluation: StatsigGateEvaluation,
      ...args: unknown[]
    ) => StatsigGateEvaluation | null;
  };
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
let heartbeatIntervalId: number | null = null;
let lastPongAt = 0;
let pingSentAt = 0;
let bridgeReady = false;
let recoveryBlocked = false;
let checkingAuthentication = false;
let authenticationExpired = false;
let lastSequence = 0;
const bridgeClientId = crypto.randomUUID();
let hasOpenedIpcConnection = false;
let reloadRequiredAfterReconnect = false;
let connectionNotice: HTMLDivElement | null = null;
let reloadRequested = false;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();
const messagePorts = new Map<string, MessagePort>();

function showConnectionNotice(reconnected: boolean): void {
  if (!document.body) {
    window.setTimeout(() => showConnectionNotice(reconnected), 0);
    return;
  }
  if (!connectionNotice) {
    connectionNotice = document.createElement("div");
    connectionNotice.setAttribute("role", "alert");
    connectionNotice.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:420px",
      "padding:14px 16px",
      "border:1px solid rgba(255,255,255,.22)",
      "border-radius:10px",
      "background:#242424",
      "color:#fff",
      "box-shadow:0 8px 28px rgba(0,0,0,.35)",
      "font:14px/1.4 system-ui,sans-serif",
    ].join(";");
    document.body.append(connectionNotice);
  }

  connectionNotice.replaceChildren(
    document.createTextNode(
      reconnected
        ? authenticationExpired
          ? "Your sign-in session has expired. Sign in again to restore your thread."
          : "Codex Web could not restore this session. Reload to retrieve the latest thread state. Your prompt will not be resent."
        : "Connection to Codex Web was lost. Reconnecting…",
    ),
  );
  if (reconnected) {
    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.textContent = authenticationExpired ? "Sign in" : "Reload";
    reloadButton.style.cssText = [
      "margin-left:12px",
      "padding:6px 10px",
      "border:0",
      "border-radius:6px",
      "background:#fff",
      "color:#111",
      "font:inherit",
      "font-weight:600",
      "cursor:pointer",
    ].join(";");
    reloadButton.addEventListener("click", () => {
      reloadRequested = true;
      connectionNotice?.remove();
      connectionNotice = null;
      if (authenticationExpired) window.location.assign("/login");
      else window.location.reload();
    });
    connectionNotice.append(" ", reloadButton);
  }
}

function markIpcConnectionLost(): void {
  if (!hasOpenedIpcConnection || reloadRequested) {
    return;
  }
  reloadRequiredAfterReconnect = true;
  showConnectionNotice(false);
}

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "bridge-event") {
    if (message.sequence <= lastSequence) return;
    if (message.sequence !== lastSequence + 1) {
      requireRendererReload("IPC event sequence gap");
      return;
    }
    handleIncomingMessage(message.message);
    lastSequence = message.sequence;
    return;
  }
  if (message.type === "bridge-reset") {
    requireRendererReload(message.reason);
    return;
  }
  if (message.type === "bridge-ready") {
    bridgeReady = true;
    const recovering = hasOpenedIpcConnection;
    hasOpenedIpcConnection = true;
    flushOutboundQueue();
    if (recovering) void recoverRendererSession();
    return;
  }
  if (message.type === "bridge-pong") {
    lastPongAt = Date.now();
    pingSentAt = 0;
    return;
  }

  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "message-port-message") {
    messagePorts.get(message.portId)?.postMessage(message.data);
    return;
  }

  if (message.type === "message-port-close") {
    const port = messagePorts.get(message.portId);
    messagePorts.delete(message.portId);
    port?.close();
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (!bridgeReady || recoveryBlocked || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const queued = outboundQueue.splice(0);
  for (let index = 0; index < queued.length; index += 1) {
    try {
      socket.send(JSON.stringify(queued[index]));
    } catch (error) {
      // send() only throws before the browser accepts the frame. Preserve the
      // unsent tail, then reconnect. Already-sent messages are never replayed:
      // an IPC action may write a file or start a command.
      outboundQueue.unshift(...queued.slice(index));
      console.warn("[electron-stub] IPC socket send failed", error);
      forceReconnect("send failed");
      return;
    }
  }
}

function requireRendererReload(reason: string): void {
  console.warn("[electron-stub] renderer recovery requires reload:", reason);
  recoveryBlocked = true;
  bridgeReady = false;
  reloadRequiredAfterReconnect = true;
  outboundQueue.length = 0;
  closeMessagePorts();
  rejectPendingRequests(`Session recovery failed: ${reason}. Reload required; do not resend the prompt until its status is restored.`);
  showConnectionNotice(true);
}

async function recoverRendererSession(): Promise<void> {
  const connection = socket;
  let timeout: number | undefined;
  try {
    const recover = window.__ELECTRON_SHIM__?.recoverIpcSession;
    if (!recover) throw new Error("Desktop recovery hook is not ready");
    await Promise.race([
      recover(),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error("Thread recovery timed out")), 30_000);
      }),
    ]);
    if (socket !== connection || !bridgeReady || recoveryBlocked) return;
    reloadRequiredAfterReconnect = false;
    connectionNotice?.remove();
    connectionNotice = null;
  } catch (error) {
    if (socket === connection) requireRendererReload(String(error));
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

function rejectPendingRequests(reason: string): void {
  const error = new Error(reason);
  for (const pending of pendingInvokes.values()) {
    pending.reject(error);
  }
  pendingInvokes.clear();

  for (const pending of pendingDirectoryEntries.values()) {
    pending.reject(error);
  }
  pendingDirectoryEntries.clear();
}

function closeMessagePorts(): void {
  for (const port of messagePorts.values()) {
    port.close();
  }
  messagePorts.clear();
}

function scheduleReconnect(delay = RECONNECT_DELAY_MS): void {
  if (reconnectTimeoutId !== null) {
    if (delay !== 0) {
      return;
    }
    window.clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, delay);
}

function forceReconnect(reason: string): void {
  const connection = socket;
  if (connection) {
    socket = null;
    bridgeReady = false;
    pingSentAt = 0;
    markIpcConnectionLost();
    if (
      connection.readyState === WebSocket.OPEN ||
      connection.readyState === WebSocket.CONNECTING
    ) {
      connection.close(4000, reason.slice(0, 123));
    }
  }
  scheduleReconnect(0);
}

async function checkAuthentication(): Promise<void> {
  if (checkingAuthentication || recoveryBlocked || reloadRequested) return;
  checkingAuthentication = true;
  try {
    const response = await fetch("/__backend/connection", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (response.status === 401) {
      authenticationExpired = true;
      requireRendererReload("Sign-in session expired");
    }
  } catch { /* Network failures use the normal reconnect path. */ }
  finally { checkingAuthentication = false; }
}

function reconnectAfterResume(): void {
  const connection = socket;
  if (!connection || connection.readyState === WebSocket.CLOSED) {
    ensureSocket();
    return;
  }

  // Sleeping tabs do not owe us a pong. Give the resumed connection a fresh
  // probe deadline instead of immediately treating its old timestamp as dead.
  if (document.visibilityState === "visible") {
    pingSentAt = 0;
    lastPongAt = Date.now();
    heartbeat();
  }
}

function heartbeat(): void {
  if (document.visibilityState === "hidden") {
    return;
  }
  if (socket?.readyState !== WebSocket.OPEN) {
    ensureSocket();
    return;
  }
  if (pingSentAt && Date.now() - pingSentAt > HEARTBEAT_TIMEOUT_MS) {
    forceReconnect("heartbeat timed out");
    return;
  }
  try {
    if (!pingSentAt) pingSentAt = Date.now();
    socket.send(JSON.stringify({ type: "bridge-ping", sentAt: Date.now() }));
  } catch (error) {
    console.warn("[electron-stub] IPC heartbeat failed", error);
    forceReconnect("heartbeat failed");
  }
}

function startHeartbeat(): void {
  if (heartbeatIntervalId !== null) {
    return;
  }
  heartbeatIntervalId = window.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
}

function ensureSocket(): void {
  if (recoveryBlocked || reloadRequested) return;
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const connection = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc?clientId=${bridgeClientId}&after=${lastSequence}&resume=${hasOpenedIpcConnection ? 1 : 0}`,
  );
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket !== connection) {
      connection.close(4000, "superseded connection");
      return;
    }
    lastPongAt = Date.now();
    pingSentAt = 0;
    // Wait for the server's replay/ready handshake before sending commands.
  });
  connection.addEventListener("message", (event) => {
    if (socket !== connection || recoveryBlocked) return;
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  connection.addEventListener("close", () => {
    if (socket !== connection) {
      return;
    }
    socket = null;
    bridgeReady = false;
    pingSentAt = 0;
    if (recoveryBlocked) return;
    markIpcConnectionLost();
    scheduleReconnect();
  });
  connection.addEventListener("error", () => {
    if (socket === connection) {
      void checkAuthentication();
      forceReconnect("socket error");
    }
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  if (recoveryBlocked) throw new Error("Session recovery requires a reload");
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function isOpenInBrowserMessage(value: unknown): value is {
  type: "open-in-browser";
  url: string;
} {
  return (
    isRecord(value) &&
    value.type === "open-in-browser" &&
    typeof value.url === "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
  directoriesOnly = true,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});
const preparingThreads = new Set<string>();
electronShim.prepareThreadPrompt = async (manager, threadId) => {
  if (reloadRequiredAfterReconnect || recoveryBlocked || !bridgeReady) throw new Error("Connection is recovering. Wait for thread status to be restored before sending.");
  if (preparingThreads.has(threadId)) throw new Error("This thread is already preparing a prompt.");
  preparingThreads.add(threadId);
  let notice: HTMLDivElement | undefined;
  try {
    const response = await fetch(`/__backend/thread-context/${encodeURIComponent(threadId)}`, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (!response.ok) throw new Error("Could not check thread context. Prompt was not sent.");
    const context = await response.json();
    if (context.available && context.imageBytes > 8 * 1024 * 1024) {
      notice = document.createElement("div");
      notice.setAttribute("role", "status");
      notice.style.cssText = "position:fixed;bottom:20px;left:20px;right:20px;z-index:2147483646;padding:16px;background:#242424;color:white;border:1px solid #777;border-radius:10px;font:14px system-ui";
      notice.textContent = "Large image history detected. Compacting context before sending your prompt…";
      document.body.append(notice);
      await compactLargeContext(manager, threadId);
    }
    if (reloadRequiredAfterReconnect || recoveryBlocked || !bridgeReady) throw new Error("Connection changed while preparing context. Prompt was not sent; check the thread before retrying.");
  } finally {
    notice?.remove();
    preparingThreads.delete(threadId);
  }
};
const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

Object.assign(globalThis, {
  process: {
    arch: "arm64",
    platform: "darwin",
    versions: {
      electron: "41.2.0",
    },
  },
});

electronShim.overrideAdapter = {
  getGateOverride(evaluation) {
    if (evaluation.name === "2138468235") {
      // MCP Apps trigger app/list discovery during shell startup. The
      // discovery endpoint can be Cloudflare-rate-limited and hold the splash
      // screen for 10+ seconds; Apps are not required for core threads.
      return {
        ...evaluation,
        value: false,
      };
    }

    if (evaluation.name === "2911712394") {
      return {
        ...evaluation,
        value: true,
      };
    }

    if (evaluation.name === "1042620455") {
      // Remote control (Slingshot).
      return {
        ...evaluation,
        value: true,
      };
    }

    return null;
  },
};

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;

let mobileSidebarOpen = false;
let mobileSidebarBackdrop: HTMLButtonElement | null = null;

function getMobileSidebarBoundary(): number {
  const persistedWidth = Number(window.localStorage.getItem("sidebar-width"));
  const sidebarWidth = Number.isFinite(persistedWidth)
    ? Math.min(Math.max(persistedWidth, 240), 520)
    : 275;

  // The resizeable sidebar is followed by the narrow navigation rail.
  return Math.min(window.innerWidth, sidebarWidth + 32);
}

function updateMobileSidebarBackdrop(): void {
  if (mobileSidebarBackdrop == null) {
    return;
  }

  const visible = mobileMediaQuery.matches && mobileSidebarOpen;
  mobileSidebarBackdrop.hidden = !visible;
  if (visible) {
    mobileSidebarBackdrop.style.left = `${getMobileSidebarBoundary()}px`;
  }
}

function installMobileSidebarBackdrop(): void {
  if (mobileSidebarBackdrop != null || !document.body) {
    return;
  }

  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.hidden = true;
  backdrop.tabIndex = -1;
  backdrop.setAttribute("aria-label", "Close sidebar");
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0 0 0 auto",
    zIndex: "2147483000",
    width: "auto",
    border: "0",
    margin: "0",
    padding: "0",
    background: "rgba(0, 0, 0, 0.36)",
    cursor: "default",
    touchAction: "manipulation",
  });
  backdrop.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    mobileSidebarOpen = false;
    updateMobileSidebarBackdrop();
    electronShim.closeSidebar?.();
  });
  document.body.append(backdrop);
  mobileSidebarBackdrop = backdrop;
  updateMobileSidebarBackdrop();
}

if (document.body) {
  installMobileSidebarBackdrop();
} else {
  document.addEventListener("DOMContentLoaded", installMobileSidebarBackdrop, {
    once: true,
  });
}

mobileMediaQuery.addEventListener("change", () => {
  if (!mobileMediaQuery.matches) {
    mobileSidebarOpen = false;
  }
  updateMobileSidebarBackdrop();
});

window.addEventListener(
  "resize",
  () => {
    updateMobileSidebarBackdrop();
  },
  { passive: true },
);

document.addEventListener(
  "keydown",
  (event) => {
    if (
      event.key !== "Escape" ||
      !mobileMediaQuery.matches ||
      !mobileSidebarOpen
    ) {
      return;
    }

    mobileSidebarOpen = false;
    updateMobileSidebarBackdrop();
    electronShim.closeSidebar?.();
  },
  true,
);

electronShim.onSidebarOpenChanged = (open) => {
  mobileSidebarOpen = open;
  updateMobileSidebarBackdrop();
};

function preferAdvancedModelPicker(): void {
  for (const toggle of document.querySelectorAll<HTMLElement>(
    '[data-model-picker-view-toggle][aria-expanded="false"]',
  )) {
    if (toggle.dataset.codexWebAdvancedPreferred === "true") {
      continue;
    }

    toggle.dataset.codexWebAdvancedPreferred = "true";
    requestAnimationFrame(() => {
      if (
        toggle.isConnected &&
        toggle.getAttribute("aria-expanded") === "false"
      ) {
        toggle.click();
      }
    });
  }
}

new MutationObserver(preferAdvancedModelPicker).observe(
  document.documentElement,
  {
    childList: true,
    subtree: true,
  },
);
preferAdvancedModelPicker();

electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    mobileSidebarOpen = false;
    updateMobileSidebarBackdrop();
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isOpenInBrowserMessage(args[0])) {
        window.open(args[0].url, "_blank", "noopener,noreferrer");
      }

      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        const workspaceRootOption = args[0];
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...workspaceRootOption, root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    if (
      channel === "codex_desktop:message-from-view" &&
      args.length === 1 &&
      isUnhandledAddWorkspaceRootOptionMessage(args[0])
    ) {
      const workspaceRootOption = args[0];
      void openSelectWorkspaceRootDialog({
        listDirectory: requestWorkspaceDirectoryEntries,
      }).then((root) => {
        if (!root) {
          return;
        }
        enqueueMessage({
          type: "ipc-renderer-send",
          channel,
          args: [{ ...workspaceRootOption, root }],
        });
      });
      return;
    }
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  postMessage(
    channel: string,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    if (transfer && transfer.length > 0) {
      const portIds = transfer.map((transferable) => {
        if (!(transferable instanceof MessagePort)) {
          throw new TypeError(
            "Only MessagePort transfers are supported by the browser IPC bridge.",
          );
        }

        const portId = `message_port_${nextRequestId()}`;
        messagePorts.set(portId, transferable);
        transferable.addEventListener("message", (event) => {
          enqueueMessage({
            type: "message-port-message",
            portId,
            data: event.data,
          });
        });
        transferable.addEventListener("messageerror", () => {
          messagePorts.delete(portId);
          enqueueMessage({ type: "message-port-close", portId });
        });
        transferable.start();
        return portId;
      });

      enqueueMessage({
        type: "ipc-renderer-post-message",
        channel,
        message,
        portIds,
      });
      return;
    }

    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args: [message],
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-uses-owl-app-shell") {
      return false;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: { id: "local", display_name: "Local", kind: "local" },
        remote_ssh_connections: [],
        remote_wsl_connections: [],
        remote_control_connections_state: {
          available: false,
          accessRequired: false,
          authRequired: false,
          clientAuthorized: false,
        },
        local_remote_control_client_id: null,
        pending_worktrees: [],
      };
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ipcRenderer.on(
  "codex-web:select-workspace-folder",
  (_event, value: unknown) => {
    const requestId =
      typeof value === "object" &&
      value !== null &&
      typeof (value as { requestId?: unknown }).requestId === "string"
        ? (value as { requestId: string }).requestId
        : null;
    if (!requestId) {
      return;
    }
    void openSelectWorkspaceRootDialog({
      listDirectory: requestWorkspaceDirectoryEntries,
    }).then(async (root) => {
      await ipcRenderer.invoke("codex-web:select-workspace-folder-result", {
        requestId,
        root,
      });
    });
  },
);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") pingSentAt = 0;
  if (document.visibilityState === "visible") {
    // Ensure a bridge exists when a suspended page resumes. Keep a healthy
    // socket intact so active MessagePorts and threads are not interrupted.
    reconnectAfterResume();
  }
});

// Prevent additional submissions while the active turn's state is uncertain.
// Recovery's internal RPCs still pass through the bridge normally.
for (const type of ["click", "keydown", "submit"] as const) {
  document.addEventListener(type, (event) => {
    if (!reloadRequiredAfterReconnect || connectionNotice?.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

window.addEventListener("pageshow", () => {
  reconnectAfterResume();
});

window.addEventListener("focus", () => {
  reconnectAfterResume();
});

window.addEventListener("online", () => {
  reconnectAfterResume();
});

window.addEventListener("beforeunload", () => {
  // Closing the old page also closes its WebSocket. Do not turn that expected
  // shutdown into a reconnect warning while a navigation/reload is underway.
  reloadRequested = true;
});

ensureSocket();
startHeartbeat();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return unimplemented("webUtils.getPathForFile");
  },
};
