import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function patchRecovery(source) {
  const anchor = "  async function l(t, n) {\n    let r = o?.roots,";
  const resumeAnchor =
    '        "maybe-resume-conversation": F9(async (e, t) => {\n          (e.activateThreadSummary(t.conversationId), await Oi(e, t));';
  if (source.includes("codex-web:official-thread-recovery")) return source;
  if (source.split(anchor).length !== 2)
    throw new Error(
      "Desktop recovery hook changed; inspect upstream Y4e before upgrading",
    );
  if (source.split(resumeAnchor).length !== 2)
    throw new Error(
      "Desktop archived-thread resume hook changed; inspect upstream before upgrading",
    );
  return source
    .replace(
      anchor,
      `  // codex-web:official-thread-recovery
  (0, P7.useEffect)(() => {
    const shim = window.__ELECTRON_SHIM__;
    if (!shim) return;
    const recover = async () => {
      if (i == null) return;
      const manager = zi(e, i);
      if (!manager) throw new Error("Active thread manager is unavailable");
      const hostId = manager.getHostId();
      await zr("mark-all-conversations-need-resume-after-reconnect-for-host", { hostId });
      if (!(await l(manager, i))) throw new Error("Active thread could not be resumed");
      await t.invalidateQueries({ queryKey: [...fn, hostId] });
    };
    shim.recoverIpcSession = recover;
    return () => { if (shim.recoverIpcSession === recover) delete shim.recoverIpcSession; };
  }, [e, t, n, i, a, o?.roots]);
${anchor}`,
    )
    .replace(
      resumeAnchor,
      `        "maybe-resume-conversation": F9(async (e, t) => {
          e.activateThreadSummary(t.conversationId);
          try {
            await Oi(e, t);
          } catch (error) {
            if (!String(error).toLowerCase().includes("archived")) throw error;
            await e.sendRequest("thread/unarchive", { threadId: t.conversationId });
            await Oi(e, t);
          }`,
    );
}

export function patchContextGuard(source) {
  if (source.includes("codex-web:context-guard")) return source;
  const anchor = "  let Ae = {\n      threadId: t,\n      ...s,";
  const resumeProvider = "        modelProvider: P.modelProvider,";
  if (source.split(anchor).length !== 2)
    throw new Error(
      "Desktop turn-start hook changed; inspect upstream before upgrading",
    );
  if (source.split(resumeProvider).length !== 2)
    throw new Error(
      "Desktop resume provider hook changed; inspect upstream before upgrading",
    );
  return source
    .replace(
      anchor,
      `  // codex-web:context-guard: before optimistic turn insertion, never replay turn/start.
  await window.__ELECTRON_SHIM__?.prepareThreadPrompt?.(e, t);
${anchor}`,
    )
    .replace(
      resumeProvider,
      "        modelProvider: e.getHostId() === `local` ? `openai-http` : P.modelProvider,",
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  const directory = process.argv[2];
  const version = createHash("sha256");
  for (const [filename, patch] of [
    ["app-initial~app-main~page-BF1QkwFT.js", patchRecovery],
    [
      "app-initial~app-main~hotkey-window-thread-page~thread-app-shell-chrome~header~remote-conver~h59fr3q5-Cm3GYhJA.js",
      patchContextGuard,
    ],
  ]) {
    const target = path.join(directory, filename);
    const source = patch(fs.readFileSync(target, "utf8"));
    fs.writeFileSync(target, source);
    version.update(source);
  }
  // Upstream hashed filenames do not change when we patch their contents.
  // Derive a cache generation so the PWA cannot retain a previous recovery hook.
  const serviceWorker = path.join(directory, "..", "service-worker.js");
  const source = fs.readFileSync(serviceWorker, "utf8");
  version.update(
    source.replace(
      /const CACHE_NAME = "[^"]+";/,
      'const CACHE_NAME = "codex-web-static-build";',
    ),
  );
  fs.writeFileSync(
    serviceWorker,
    source.replace(
      /const CACHE_NAME = "[^"]+";/,
      `const CACHE_NAME = "codex-web-static-${version.digest("hex").slice(0, 16)}";`,
    ),
  );
}
