"use strict";

const assert = require("node:assert/strict");
const { execFile: execFileCallback } = require("node:child_process");
const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const zlib = require("node:zlib");
const startPlugin = require("../plugin");
const {
  createPlaybackOperation,
} = require("../plugin/playback-operation");

const execFile = promisify(execFileCallback);
const { calculatePlaybackDelayMs } = startPlugin._test;

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

test("numeric playback rate throttles against an anchored source clock", () => {
  assert.equal(
    calculatePlaybackDelayMs({
      nextSourceMs: 120000,
      sourceAnchorMs: 100000,
      wallAnchorMs: 1000,
      rate: 10,
      nowMs: 2500,
    }),
    500,
  );
});

test("numeric playback rate stops delaying once playback is behind schedule", () => {
  assert.equal(
    calculatePlaybackDelayMs({
      nextSourceMs: 120000,
      sourceAnchorMs: 100000,
      wallAnchorMs: 1000,
      rate: 20,
      nowMs: 2500,
    }),
    0,
  );
});

test("max playback never applies timing delay", () => {
  assert.equal(
    calculatePlaybackDelayMs({
      nextSourceMs: 120000,
      sourceAnchorMs: 100000,
      wallAnchorMs: 1000,
      rate: "max",
      nowMs: 1000,
    }),
    0,
  );
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

test("voyage playback loads local reference capture segments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capture-plus-reference-voyage-"));
  const app = fakeApp();
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
  });

  try {
    const capturesDir = path.join(root, "captures");
    const voyagesDir = path.join(root, "voyages");
    const captureName = "capture-2026-06-26T18-59-15-290Z.jsonl";
    const capturePath = path.join(capturesDir, `${captureName}.gz`);
    const envelope = captureEnvelope("2026-06-26T18:59:15.290Z");
    await fs.writeFile(capturePath, zlib.gzipSync(`${JSON.stringify(envelope)}\n`));

    const staging = path.join(root, "voyage-stage");
    await fs.mkdir(path.join(staging, "capture"), { recursive: true });
    await fs.writeFile(
      path.join(staging, "index.json"),
      `${JSON.stringify({
        id: "voyage-20260626T185915Z",
        captureMode: "voyage",
        captureFileMode: "reference",
        captureFiles: [],
        captureReferences: [
          {
            fileName: captureName,
            sourcePath: path.join(capturesDir, captureName),
            compressedSourcePath: capturePath,
          },
        ],
      })}\n`,
    );
    await execFile("zip", ["-qr", path.join(voyagesDir, "voyage-20260626T185915Z.zip"), "."], {
      cwd: staging,
    });

    const response = await invoke(routes, "POST", "/playback/load", {
      file: "voyage-20260626T185915Z.zip",
      kind: "voyages",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.playback.loaded, true);
    assert.equal(response.body.playback.totalLines, 1);
    assert.equal(response.body.playback.voyageFileName, "voyage-20260626T185915Z.zip");
    assert.equal(response.body.playback.fileName, captureName);
    assert.equal(response.body.playback.compressed, false);
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

function routerMap(routes) {
  return {
    get(route, handler) {
      routes.set(`GET ${route}`, handler);
    },
    post(route, handler) {
      routes.set(`POST ${route}`, handler);
    },
  };
}

async function invoke(routes, method, route, body = {}) {
  let statusCode = 200;
  let payload;
  const handler = routes.get(`${method} ${route}`);
  assert.ok(handler, `expected route ${method} ${route}`);
  await handler(
    { body },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        payload = value;
      },
    },
  );
  return { statusCode, body: payload };
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
