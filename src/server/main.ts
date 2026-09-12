#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { glob } from "glob";
import { AuthService, type AppRole, type AuthSession } from "./auth";
import { adminPage, deviceAuthPage, loginPage, logoutPage } from "./auth-ui";
import { BridgeSession } from "./bridge-session";
import { getThreadImageContext } from "./thread-context";

type ServerOptions = {
  host: string;
  port: number;
};

type RequestWithSession = {
  authSession?: AuthSession;
};

type DeviceLoginJob = {
  id: string;
  userId: string;
  output: string;
  state: "running" | "succeeded" | "failed";
};

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
      sourceUrl: string;
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
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

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
  );
}

type MessagePortListener = (...args: unknown[]) => void;

type BridgedMessagePort = {
  close: () => void;
  on: (event: string, listener: MessagePortListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};

class WebSocketMessagePort implements BridgedMessagePort {
  private closed = false;
  private readonly listeners = new Map<string, Set<MessagePortListener>>();

  constructor(
    private readonly portId: string,
    private readonly sendToRenderer: (message: MainToRendererMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  on(event: string, listener: MessagePortListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);

    return this;
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-message",
      portId: this.portId,
      data,
    });
  }

  start(): void {}

  close(): void {
    if (!this.markClosed()) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-close",
      portId: this.portId,
    });
  }

  receiveMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    const listeners = this.listeners.get("message");
    if (!listeners || listeners.size === 0) {
      return;
    }
    for (const listener of listeners) {
      listener({ data });
    }
  }

  disconnect(): void {
    if (!this.markClosed()) {
      return;
    }
    this.emit("close");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private markClosed(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.onClosed();
    return true;
  }
}

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  handleRendererInvoke?: (channel: string, args: unknown[]) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    sourceUrl?: string,
  ) => void;
  handleRendererSend?: (channel: string, args: unknown[]) => void;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\r", "");
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  // The browser client must never start in the container user's home. In a
  // shared deployment that would expose CODEX_HOME and makes users select an
  // unrelated folder instead of the bind-mounted project workspace.
  const configuredRoot = path.resolve(
    process.env.CODEX_WORKSPACE_ROOT?.trim() || "/workspace",
  );
  let workspaceRoot: string;
  try {
    workspaceRoot = await fs.realpath(configuredRoot);
  } catch {
    throw new Error(
      `Configured workspace root is unavailable: ${configuredRoot}. Check CODEX_WORKSPACE_PATH and the /workspace Docker mount.`,
    );
  }

  const requestedPath = directoryPath?.trim() || workspaceRoot;
  const unresolvedPath = path.resolve(requestedPath);
  if (!isPathInside(workspaceRoot, unresolvedPath)) {
    throw new Error(`Folder must be inside the shared workspace: ${workspaceRoot}`);
  }

  let resolvedPath: string;
  try {
    // realpath prevents a symlink inside /workspace from escaping the boundary.
    resolvedPath = await fs.realpath(unresolvedPath);
  } catch {
    throw new Error(`Directory not found: ${requestedPath}`);
  }
  if (!isPathInside(workspaceRoot, resolvedPath)) {
    throw new Error(`Folder must be inside the shared workspace: ${workspaceRoot}`);
  }
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const parentPath =
    resolvedPath === workspaceRoot ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    resourcesPath?: string;
    type?: string;
  };
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const publicOrigin = process.env.CODEX_WEB_PUBLIC_ORIGIN?.replace(/\/$/, "");
  const auth = new AuthService();
  const deviceLoginJobs = new Map<string, DeviceLoginJob>();
  const failedLogins = new Map<string, { attempts: number; resetAt: number }>();
  let activeDeviceLoginJob: DeviceLoginJob | null = null;

  const bodyObject = (body: unknown): Record<string, unknown> =>
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const requireAdmin = (session: AuthSession): void => {
    if (session.role !== "account_admin") {
      throw new Error("Administrator access is required");
    }
  };
  const requireCsrf = (request: { headers: Record<string, string | string[] | undefined> }, session: AuthSession): void => {
    const token = request.headers["x-csrf-token"];
    if (typeof token !== "string" || token !== session.csrfToken) {
      throw new Error("Invalid CSRF token");
    }
  };
  const runCodex = async (args: string[]): Promise<{ code: number | null; output: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.env.CODEX_AUTH_CLI_PATH ?? "codex", args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const append = (chunk: Buffer): void => {
        output = `${output}${chunk.toString()}`.slice(-8_000);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => resolve({ code: null, output: error.message }));
      child.on("close", (code) => resolve({ code, output: stripAnsi(output) }));
    });

  // The admin UI sends an empty JSON POST for actions that only need the
  // session and CSRF token (for example, starting Device Auth). Fastify's
  // default parser rejects an empty application/json body before the route is
  // reached, so accept it as an empty object while retaining JSON validation.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = String(body);
      if (text.trim() === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        const error = new Error("Invalid JSON request body") as Error & {
          statusCode?: number;
        };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  app.get("/healthz", async () => ({ ok: true }));
  app.addHook("onRequest", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (
      pathname === "/healthz" ||
      pathname === "/login" ||
      pathname === "/__auth/login" ||
      pathname === "/manifest.json" ||
      pathname === "/service-worker.js" ||
      pathname.startsWith("/assets/") ||
      pathname.startsWith("/__auth-assets/")
    ) {
      return;
    }
    const session = auth.authenticate(request.headers.cookie);
    if (!session) {
      if (pathname.startsWith("/__")) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      return reply.redirect("/login");
    }
    (request as typeof request & RequestWithSession).authSession = session;
    if (
      activeDeviceLoginJob?.state === "running" &&
      !pathname.startsWith("/__admin/") &&
      pathname !== "/admin"
    ) {
      return reply.code(503).send({ error: "Account maintenance is in progress" });
    }
  });

  app.get("/__backend/connection", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { ok: true };
  });

  app.get<{ Params: { threadId: string } }>("/__backend/thread-context/:threadId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!/^[a-f0-9-]{36}$/i.test(request.params.threadId)) return reply.code(400).send({ error: "Invalid thread ID" });
    return getThreadImageContext(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), request.params.threadId);
  });

  app.get("/login", async (request, reply) => {
    if (auth.authenticate(request.headers.cookie)) {
      return reply.redirect("/");
    }
    return reply.type("text/html; charset=utf-8").send(loginPage());
  });

  app.post("/__auth/login", async (request, reply) => {
    const remoteAddress = request.ip;
    const previous = failedLogins.get(remoteAddress);
    if (previous && previous.resetAt > Date.now() && previous.attempts >= 10) {
      return reply.code(429).send({ error: "Too many sign-in attempts. Try again later." });
    }
    if (previous && previous.resetAt <= Date.now()) {
      failedLogins.delete(remoteAddress);
    }
    const body = bodyObject(request.body);
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const result = auth.login(email, password);
    if (!result) {
      const attempt = failedLogins.get(remoteAddress);
      failedLogins.set(remoteAddress, {
        attempts: (attempt?.attempts ?? 0) + 1,
        resetAt: Date.now() + 15 * 60 * 1_000,
      });
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    failedLogins.delete(remoteAddress);
    return reply
      .header("set-cookie", auth.cookie(result.token))
      .send({ ok: true, role: result.session.role });
  });

  app.post("/__auth/logout", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    try {
      requireCsrf(request, session);
    } catch (error) {
      return reply.code(403).send({ error: errorMessage(error) });
    }
    auth.logout(request.headers.cookie);
    auth.audit(session.userId, "user.logout");
    return reply.header("set-cookie", auth.clearCookie()).send({ ok: true });
  });

  app.get("/logout", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    return reply.type("text/html; charset=utf-8").send(logoutPage(session));
  });

  app.get("/admin", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    if (session.role !== "account_admin") {
      return reply.code(403).type("text/plain").send("Administrator access is required");
    }
    return reply.type("text/html; charset=utf-8").send(adminPage(session));
  });

  app.get("/admin/device-auth", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    if (session.role !== "account_admin") {
      return reply.code(403).type("text/plain").send("Administrator access is required");
    }
    return reply.type("text/html; charset=utf-8").send(deviceAuthPage(session));
  });

  app.get("/__admin/users", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    try {
      requireAdmin(session);
      return { users: auth.listUsers() };
    } catch (error) {
      return reply.code(403).send({ error: errorMessage(error) });
    }
  });

  app.post("/__admin/users", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    const body = bodyObject(request.body);
    try {
      requireAdmin(session);
      requireCsrf(request, session);
      const role: AppRole = body.role === "account_admin" ? "account_admin" : "member";
      const user = auth.createUser(
        typeof body.email === "string" ? body.email : "",
        typeof body.password === "string" ? body.password : "",
        role,
      );
      auth.audit(session.userId, "user.created", user.email);
      return reply.code(201).send({ user });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/__admin/account/status", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    try {
      requireAdmin(session);
      const result = await runCodex(["login", "status"]);
      return { status: result.output.trim() || `Exit code: ${result.code ?? "unknown"}` };
    } catch (error) {
      return reply.code(403).send({ error: errorMessage(error) });
    }
  });

  app.post("/__admin/account/device-login", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    try {
      requireAdmin(session);
      requireCsrf(request, session);
      if (activeDeviceLoginJob?.state === "running") {
        throw new Error("Another Device Auth operation is already in progress");
      }
      if (sockets.size > 0) {
        throw new Error("Ask all users to close Codex Web before changing the shared account");
      }
      const job: DeviceLoginJob = {
        id: randomUUID(),
        userId: session.userId,
        output: "Starting Device Auth…\n",
        state: "running",
      };
      deviceLoginJobs.set(job.id, job);
      activeDeviceLoginJob = job;
      auth.audit(session.userId, "codex_account.device_auth_started");
      const child = spawn(process.env.CODEX_AUTH_CLI_PATH ?? "codex", ["login", "--device-auth"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const append = (chunk: Buffer): void => {
        job.output = `${job.output}${chunk.toString()}`.slice(-8_000);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (error) => {
        job.output += `\n${error.message}`;
        job.state = "failed";
        auth.audit(session.userId, "codex_account.device_auth_failed", error.message);
      });
      child.on("close", (code) => {
        job.state = code === 0 ? "succeeded" : "failed";
        auth.audit(
          session.userId,
          job.state === "succeeded" ? "codex_account.device_auth_succeeded" : "codex_account.device_auth_failed",
          `exit=${code ?? "unknown"}`,
        );
      });
      return reply.code(202).send({ id: job.id });
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.get("/__admin/account/device-login/:id", async (request, reply) => {
    const session = (request as typeof request & RequestWithSession).authSession!;
    try {
      requireAdmin(session);
      const id = (request.params as { id?: string }).id;
      const job = id ? deviceLoginJobs.get(id) : undefined;
      if (!job || job.userId !== session.userId) {
        return reply.code(404).send({ error: "Device Auth operation not found" });
      }
      return { id: job.id, state: job.state, output: stripAnsi(job.output) };
    } catch (error) {
      return reply.code(403).send({ error: errorMessage(error) });
    }
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Infinity,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";

          const uploadedPath = path.join(uploadRoot, randomUUID());

          await fs.writeFile(uploadedPath, await part.toBuffer());

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "public"),
    prefix: "/__auth-assets/",
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
  });

  await app.register(fastifyStatic, {
    root: path.resolve(__dirname, "../../scratch/asar/webview"),
    prefix: "/",
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    const origin = request.headers.origin;
    try {
      const parsedOrigin = origin ? new URL(origin) : null;
      const actualOrigin = parsedOrigin?.origin ?? null;
      const isAllowedOrigin = publicOrigin
        ? actualOrigin === publicOrigin
        : parsedOrigin?.host === host;
      if (!isAllowedOrigin) {
        console.warn("[ipc-bridge] rejected websocket with an unexpected Origin", {
          origin: origin ?? null,
          host,
          publicOrigin: publicOrigin ?? null,
        });
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!auth.authenticate(request.headers.cookie)) {
      console.warn("[ipc-bridge] rejected unauthenticated websocket");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeDeviceLoginJob?.state === "running") {
      console.warn("[ipc-bridge] rejected websocket during account maintenance");
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  const bridgeSessions = new Map<string, {
    replay: BridgeSession;
    ports: Map<string, WebSocketMessagePort>;
    socket: WebSocket | null;
    expiry: ReturnType<typeof setTimeout> | null;
  }>();
  const legacySockets = new Set<WebSocket>();
  const dispatchedEvents = new WeakMap<object, Set<string>>();
  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    // Desktop can route the SAME event object through multiple window targets
    // synchronously. Suppress that routing duplication only, never equal text
    // emitted by distinct streaming notifications.
    if (message.type === "ipc-main-event") {
      const event = message.args[0];
      if (event && typeof event === "object") {
        const channels = dispatchedEvents.get(event) ?? new Set<string>();
        if (channels.has(message.channel)) return;
        channels.add(message.channel);
        dispatchedEvents.set(event, channels);
        queueMicrotask(() => dispatchedEvents.delete(event));
      }
    }
    for (const session of bridgeSessions.values()) session.replay.publish(message);
    for (const socket of legacySockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }
  };

  websocketServer.on("connection", (socket, request) => {
    sockets.add(socket);
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    const clientId = query.get("clientId");
    const authSession = auth.authenticate(request.headers.cookie);
    const sessionKey = clientId && authSession && /^[a-zA-Z0-9-]{16,80}$/.test(clientId)
      ? `${authSession.id}:${clientId}` : null;
    let session = sessionKey ? bridgeSessions.get(sessionKey) : undefined;
    if (sessionKey && !session && query.get("resume") === "1") {
      socket.send(JSON.stringify({ type: "bridge-reset", reason: "Session expired or server restarted" }));
      socket.close(4001, "renderer reload required");
      sockets.delete(socket);
      return;
    }
    if (sessionKey && !session) {
      session = { replay: new BridgeSession(), ports: new Map(), socket: null, expiry: null };
      bridgeSessions.set(sessionKey, session);
    }
    const messagePorts = session?.ports ?? new Map<string, WebSocketMessagePort>();
    const sendToRenderer = (message: MainToRendererMessage): void => {
      if (session) session.replay.publish(message);
      else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    if (session) {
      if (session.expiry) clearTimeout(session.expiry);
      session.expiry = null;
      session.socket?.close(4000, "superseded connection");
      session.socket = socket;
      if (!session.replay.attach(Number(query.get("after") ?? 0), (json) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(json);
      })) {
        session.replay.detach();
        session.socket = null;
        for (const port of messagePorts.values()) port.disconnect();
        bridgeSessions.delete(sessionKey!);
        socket.send(JSON.stringify({ type: "bridge-reset", reason: "Recovery buffer exhausted" }));
        socket.close(4001, "renderer reload required");
        sockets.delete(socket);
        return;
      }
      socket.send(JSON.stringify({ type: "bridge-ready" }));
    } else legacySockets.add(socket);
    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
      sourceUrl?: string,
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, sourceUrl);
        return;
      }

      console.error(
        `[ipc-bridge] no ipcMain postMessage handler for channel ${channel}`,
      );
      for (const port of ports) {
        port.close();
      }
    };

    socket.on("close", () => {
      sockets.delete(socket);
      legacySockets.delete(socket);
      if (session) {
        if (session.socket !== socket) return;
        session.socket = null;
        session.replay.detach();
        session.expiry = setTimeout(() => {
          for (const port of messagePorts.values()) port.disconnect();
          messagePorts.clear();
          bridgeSessions.delete(sessionKey!);
        }, 120_000);
        session.expiry.unref();
      } else {
        for (const port of messagePorts.values()) port.disconnect();
        messagePorts.clear();
      }
    });

    socket.on("message", (rawData) => {
      if (session && session.socket !== socket) return;
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      if (message.type === "bridge-ping") {
        if (socket.readyState === WebSocket.OPEN) {
          const pong: MainToRendererMessage = {
            type: "bridge-pong",
            sentAt: message.sentAt,
          };
          socket.send(JSON.stringify(pong));
        }
        return;
      }

      if (message.type === "ipc-renderer-send") {
        bridgeState.handleRendererSend?.(message.channel, message.args);
        return;
      }

      if (message.type === "ipc-renderer-post-message") {
        if (new Set(message.portIds).size !== message.portIds.length) {
          console.error("[ipc-bridge] duplicate transferred MessagePort id");
          return;
        }

        const ports = message.portIds.map((portId) => {
          const existingPort = messagePorts.get(portId);
          if (existingPort) {
            existingPort.disconnect();
          }
          const port = new WebSocketMessagePort(
            portId,
            sendToRenderer,
            () => messagePorts.delete(portId),
          );
          messagePorts.set(portId, port);
          return port;
        });

        dispatchPostMessage(
          message.channel,
          message.message,
          ports,
          message.sourceUrl,
        );
        return;
      }

      if (message.type === "message-port-message") {
        messagePorts.get(message.portId)?.receiveMessage(message.data);
        return;
      }

      if (message.type === "message-port-close") {
        messagePorts.get(message.portId)?.disconnect();
        return;
      }

      if (message.type === "workspace-directory-entries-request") {
        const { requestId } = message;
        getWorkspaceDirectoryEntries(message)
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: true,
              result,
            };
            sendToRenderer(payload);
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            sendToRenderer(payload);
          });
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        const { channel, requestId, args } = message;
        Promise.resolve(
          bridgeState.handleRendererInvoke?.(channel, args) ??
            Promise.reject(
              new Error(
                `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
              ),
            ),
        )
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: true,
              result,
            };
            sendToRenderer(payload);
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            sendToRenderer(payload);
          });
      }
    });
  });

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../scratch/asar/package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
  };

  const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
    nodir: true,
    cwd: __dirname,
  });

  if (matches.length === 0) {
    throw new Error("no main bundle found");
  }

  if (matches.length > 1) {
    throw new Error("multiple main bundles found");
  }

  const module = require(matches[0]!);
  module.runMainAppStartup();
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));
