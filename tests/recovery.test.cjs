const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function loadTs(relative) {
  const filename = path.resolve(__dirname, relative);
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    filename,
  );
  return module.exports;
}
const { BridgeSession } = loadTs("../src/server/bridge-session.ts");
const { imageContextBytes } = loadTs("../src/server/thread-context.ts");
const { compactLargeContext } = loadTs("../src/browser/thread-context.ts");

test("reconnect replays missed deltas and completion, not already consumed events", () => {
  const session = new BridgeSession();
  const first = [],
    restored = [];
  assert.equal(
    session.attach(0, (json) => first.push(JSON.parse(json))),
    true,
  );
  session.publish({ type: "delta", text: "a" });
  session.detach();
  session.publish({ type: "delta", text: "a" });
  session.publish({ type: "turn/completed", status: "completed" });
  assert.equal(
    session.attach(1, (json) => restored.push(JSON.parse(json))),
    true,
  );
  assert.deepEqual(
    restored.map((e) => e.sequence),
    [2, 3],
  );
  assert.equal(restored[1].message.status, "completed");
  assert.equal(first.length, 1);
});

test("identical text notifications remain distinct; invoke/port responses survive disconnect", () => {
  const session = new BridgeSession();
  for (const message of [
    { text: "a" },
    { text: "a" },
    { type: "ipc-renderer-invoke-result", requestId: "1" },
    { type: "message-port-message", portId: "p" },
  ])
    session.publish(message);
  const restored = [];
  assert.equal(
    session.attach(0, (json) => restored.push(JSON.parse(json))),
    true,
  );
  assert.equal(restored.length, 4);
});

test("missing replay history requires reset instead of silently dropping events", () => {
  const session = new BridgeSession(200);
  for (let i = 0; i < 10; i++) session.publish({ text: "a".repeat(100) });
  assert.equal(
    session.attach(0, () => assert.fail("must not replay partial history")),
    false,
  );
  assert.equal(
    session.attach(10, () => {}),
    true,
  );
  assert.equal(
    session.attach(11, () => {}),
    false,
  );
  assert.equal(
    session.attach(NaN, () => {}),
    false,
  );
});

async function* records(values) {
  for (const value of values) yield JSON.stringify(value);
}
const image = "data:image/png;base64,AAAA";
test("context accounting ignores transcript duplication and resets at compaction", async () => {
  assert.equal(
    await imageContextBytes(
      records([
        { type: "response_item", payload: { image } },
        { type: "event_msg", payload: { image } },
      ]),
    ),
    4,
  );
  assert.equal(
    await imageContextBytes(
      records([
        { type: "response_item", payload: { image } },
        { type: "compacted", payload: { replacement_history: [] } },
        { type: "response_item", payload: { image } },
      ]),
    ),
    4,
  );
});

function manager(status = "idle") {
  let callback;
  const fake = {
    calls: 0,
    removed: false,
    async sendRequest() {
      return { thread: { status: { type: status } } };
    },
    async compactThread() {
      fake.calls++;
    },
    addNotificationCallback(_, cb) {
      callback = cb;
      return () => {
        fake.removed = true;
      };
    },
    emit(method, params) {
      callback({ method, params });
    },
  };
  return fake;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("compaction waits for matching terminal event, not RPC acknowledgement or unrelated turn", async () => {
  const fake = manager();
  let done = false;
  const result = compactLargeContext(fake, "thread", 1000).then(() => {
    done = true;
  });
  await tick();
  assert.equal(fake.calls, 1);
  assert.equal(done, false);
  fake.emit("item/started", {
    threadId: "thread",
    turnId: "compact",
    item: { type: "contextCompaction" },
  });
  fake.emit("turn/completed", {
    threadId: "other",
    turn: { id: "compact", status: "completed" },
  });
  fake.emit("turn/completed", {
    threadId: "thread",
    turn: { id: "other", status: "completed" },
  });
  assert.equal(done, false);
  fake.emit("turn/completed", {
    threadId: "thread",
    turn: { id: "compact", status: "completed" },
  });
  await result;
  assert.equal(fake.removed, true);
});
test("active turn is never compacted by preflight", async () => {
  const fake = manager("active");
  await assert.rejects(compactLargeContext(fake, "thread"), /active turn/);
  assert.equal(fake.calls, 0);
});
for (const terminalStatus of ["systemError", "notLoaded"]) {
  test(`preflight compacts after terminal ${terminalStatus} status`, async () => {
    const fake = manager(terminalStatus);
    const result = compactLargeContext(fake, "thread", 1000);
    await tick();
    assert.equal(fake.calls, 1);
    fake.emit("item/started", {
      threadId: "thread",
      turnId: "compact",
      item: { type: "contextCompaction" },
    });
    fake.emit("turn/completed", {
      threadId: "thread",
      turn: { id: "compact", status: "completed" },
    });
    await result;
    assert.equal(fake.removed, true);
  });
}
test("failed compaction rejects prompt preparation and removes listener", async () => {
  const fake = manager();
  const result = compactLargeContext(fake, "thread", 1000);
  await tick();
  fake.emit("item/started", {
    threadId: "thread",
    turnId: "compact",
    item: { type: "contextCompaction" },
  });
  fake.emit("turn/completed", {
    threadId: "thread",
    turn: {
      id: "compact",
      status: "failed",
      error: { message: "upstream failed" },
    },
  });
  await assert.rejects(result, /upstream failed/);
  assert.equal(fake.removed, true);
});
test("compaction timeout does not start or resend a prompt", async () => {
  const fake = manager();
  await assert.rejects(
    compactLargeContext(fake, "thread", 10),
    /prompt was not sent/,
  );
  assert.equal(fake.calls, 1);
  assert.equal(fake.removed, true);
});

test("upstream patches fail closed on drift and are idempotent", async () => {
  const { patchRecovery, patchContextGuard } =
    await import("../scripts/patch_upstream_recovery.mjs");
  for (const patch of [patchRecovery, patchContextGuard])
    assert.throws(() => patch("changed upstream"));
  const source =
    "  async function l(t, n) {\n    let r = o?.roots,\n" +
    '        "maybe-resume-conversation": F9(async (e, t) => {\n' +
    "          (e.activateThreadSummary(t.conversationId), await Oi(e, t));";
  assert.equal(patchRecovery(patchRecovery(source)), patchRecovery(source));
  assert.match(patchRecovery(source), /thread\/unarchive/);
  const turnSource =
    "  let Ae = {\n      threadId: t,\n      ...s,\n        modelProvider: P.modelProvider,";
  const patched = patchContextGuard(turnSource);
  assert.equal(patchContextGuard(patched), patched);
  assert.match(patched, /e\.getHostId\(\) === `local` \? `openai-http`/);
});
