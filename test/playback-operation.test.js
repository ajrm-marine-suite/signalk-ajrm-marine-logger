"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const startPlugin = require("../plugin");
const {
  createPlaybackOperation,
} = require("../plugin/playback-operation");

test("stopping invalidates an in-flight playback operation", () => {
  const operation = createPlaybackOperation();
  const playbackGeneration = operation.begin();
  assert.equal(operation.isCurrent(playbackGeneration), true);
  operation.invalidate();
  assert.equal(operation.isCurrent(playbackGeneration), false);
});

test("a restarted playback receives a distinct current generation", () => {
  const operation = createPlaybackOperation();
  const first = operation.begin();
  operation.invalidate();
  const second = operation.begin();
  assert.notEqual(second, first);
  assert.equal(operation.isCurrent(first), false);
  assert.equal(operation.isCurrent(second), true);
});

test("voyage status ignores Voyage Viewer plot sidecars", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capture-plus-voyages-"));
  const app = fakeApp();
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
  });

  try {
    const voyagesDir = path.join(root, "voyages");
    await fs.writeFile(path.join(voyagesDir, "voyage-20260622T203128Z.zip"), "zip placeholder");
    await fs.writeFile(
      path.join(voyagesDir, "voyage-20260622T203128Z.zip.watchkeeper-plot.json"),
      "{}",
    );

    const status = await app.ajrmMarineLoggerApi.status();
    assert.deepEqual(
      status.voyages.map((voyage) => voyage.fileName),
      ["voyage-20260622T203128Z.zip"],
    );
  } finally {
    plugin.stop();
  }
});

test("capture backfill ignores buffer files from before plugin start", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capture-plus-old-buffer-"));
  const bufferDir = path.join(root, "buffer");
  await fs.mkdir(bufferDir, { recursive: true });
  await fs.writeFile(
    path.join(bufferDir, "buffer-2026-06-22T20-00-00-000Z.jsonl"),
    `${JSON.stringify(captureEnvelope("2026-06-22T20:00:00.000Z"))}\n`,
  );

  const app = fakeApp();
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
  });

  try {
    const recording = await app.ajrmMarineLoggerApi.startCapture({ backfillMinutes: 30 });
    assert.equal(recording.backfilled, 0);
    assert.equal(recording.lines, 0);
  } finally {
    plugin.stop();
  }
});

test("capture backfill keeps current plugin run buffer entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capture-plus-current-buffer-"));
  const app = fakeApp();
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
  });

  try {
    app.signalk.emit("delta", captureDelta(new Date().toISOString()));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const recording = await app.ajrmMarineLoggerApi.startCapture({ backfillMinutes: 30 });
    assert.equal(recording.backfilled, 1);
    assert.equal(recording.lines, 1);
  } finally {
    plugin.stop();
  }
});

test("AJRM Marine Pi Controller power intent closes active capture", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capture-plus-power-intent-"));
  const app = fakeApp();
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
  });

  try {
    const recording = await app.ajrmMarineLoggerApi.startCapture({ backfillMinutes: 0 });
    assert.equal(recording.fileName.endsWith(".jsonl"), true);
    app.signalk.emit("delta", powerIntentDelta());
    const status = await app.ajrmMarineLoggerApi.status();
    assert.equal(status.recording, null);
    assert.equal(status.recentEvents[0].event, "power-intent");
  } finally {
    plugin.stop();
  }
});

function fakeApp() {
  return {
    signalk: new EventEmitter(),
    setPluginStatus() {},
    handleMessage() {},
    debug() {},
    error() {},
  };
}

function captureEnvelope(timestamp) {
  return {
    capturedAt: timestamp,
    delta: captureDelta(timestamp),
  };
}

function captureDelta(timestamp) {
  return {
    context: "vessels.self",
    updates: [
      {
        timestamp,
        values: [
          {
            path: "navigation.speedOverGround",
            value: 5,
          },
        ],
      },
    ],
  };
}

function powerIntentDelta() {
  return {
    context: "vessels.self",
    updates: [
      {
        timestamp: new Date().toISOString(),
        values: [
          {
            path: "plugins.ajrmMarinePiController.power.intent",
            value: {
              action: "shutdown",
              requestedAt: new Date().toISOString(),
              runAt: new Date(Date.now() + 10000).toISOString(),
              graceSeconds: 10,
              status: "waiting",
            },
          },
        ],
      },
    ],
  };
}
