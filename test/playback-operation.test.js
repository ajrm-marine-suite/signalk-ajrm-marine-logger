"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const AdmZip = require("adm-zip");
const startPlugin = require("../plugin");
const {
  createPlaybackOperation,
} = require("../plugin/playback-operation");

const {
  calculatePlaybackDelayMs,
  replayDeltaAsLiveInputs,
  shouldReplayInputPath,
} = startPlugin._test;

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

test("voyage downloads defer to Capture portable bundle builder when available", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "plugin", "index.js"), "utf8");
  assert.match(source, /prepareCaptureVoyageDownload\(fileName\)/);
  assert.match(source, /api\.prepareVoyageDownload\(fileName\)/);
  assert.match(source, /kind === "voyages"/);
  assert.match(source, /captureDownload\.cleanup\(\)/);
});

test("playback republishes raw inputs with fresh timestamps and drops derived paths", () => {
  const replayed = replayDeltaAsLiveInputs(
    {
      context: "vessels.self",
      updates: [
        {
          timestamp: "2026-06-24T10:00:00.000Z",
          values: [
            {
              path: "navigation.position",
              value: {
                value: { latitude: 56.2, longitude: -5.5 },
                timestamp: "2026-06-24T10:00:00.000Z",
                values: {
                  gps: {
                    value: { latitude: 56.2, longitude: -5.5 },
                    timestamp: "2026-06-24T10:00:00.000Z",
                  },
                },
              },
            },
            {
              path: "notifications.navigation.gnss.integrity",
              value: {
                state: "alarm",
                message: "Old GPS integrity warning",
              },
            },
            {
              path: "plugins.ajrmMarineGpsIntegrity.trusted.timestamp",
              value: "2026-06-24T10:00:00.000Z",
            },
          ],
        },
      ],
    },
    "2026-06-27T12:00:00.000Z",
  );

  assert.equal(replayed.updates.length, 1);
  assert.equal(replayed.updates[0].timestamp, "2026-06-27T12:00:00.000Z");
  assert.deepEqual(
    replayed.updates[0].values.map((entry) => entry.path),
    ["navigation.position"],
  );
  assert.equal(replayed.updates[0].values[0].value.timestamp, "2026-06-27T12:00:00.000Z");
  assert.equal(
    replayed.updates[0].values[0].value.values.gps.timestamp,
    "2026-06-27T12:00:00.000Z",
  );
});

test("playback strips derived fields from root vessel deltas", () => {
  const replayed = replayDeltaAsLiveInputs(
    {
      context: "vessels.self",
      updates: [
        {
          timestamp: "2026-06-24T10:00:00.000Z",
          values: [
            {
              path: "",
              value: {
                name: "Test Boat",
                navigation: {
                  speedOverGround: {
                    value: 2.5,
                    timestamp: "2026-06-24T10:00:00.000Z",
                  },
                },
                notifications: {
                  navigation: {
                    gnss: {
                      integrity: {
                        value: { state: "alarm" },
                      },
                    },
                  },
                },
                plugins: {
                  ajrmMarineGpsIntegrity: {
                    trusted: {
                      timestamp: {
                        value: "2026-06-24T10:00:00.000Z",
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    },
    "2026-06-27T12:00:00.000Z",
  );

  assert.equal(replayed.updates[0].values[0].path, "");
  assert.equal(replayed.updates[0].values[0].value.name, "Test Boat");
  assert.equal(replayed.updates[0].values[0].value.notifications, undefined);
  assert.equal(replayed.updates[0].values[0].value.plugins, undefined);
  assert.equal(
    replayed.updates[0].values[0].value.navigation.speedOverGround.timestamp,
    "2026-06-27T12:00:00.000Z",
  );
});

test("playback drops root deltas that contain only derived state", () => {
  const replayed = replayDeltaAsLiveInputs(
    {
      context: "vessels.self",
      updates: [
        {
          timestamp: "2026-06-24T10:00:00.000Z",
          values: [
            {
              path: "",
              value: {
                plugins: {
                  ajrmMarineCapture: { state: { value: "watching" } },
                },
                notifications: {
                  navigation: { gnss: { integrity: { value: { state: "alarm" } } } },
                },
              },
            },
          ],
        },
      ],
    },
    "2026-06-27T12:00:00.000Z",
  );

  assert.equal(replayed, null);
});

test("playback input path classification keeps raw paths and rejects derived paths", () => {
  assert.equal(shouldReplayInputPath("navigation.position"), true);
  assert.equal(shouldReplayInputPath("environment.wind.speedApparent"), true);
  assert.equal(shouldReplayInputPath(""), true);
  assert.equal(shouldReplayInputPath("notifications.navigation.gnss.integrity"), false);
  assert.equal(shouldReplayInputPath("plugins.ajrmMarineGpsIntegrity.trusted.timestamp"), false);
  assert.equal(shouldReplayInputPath("plugins.ajrmMarineLogger.playback"), false);
});

test("voyage status ignores Voyage Viewer plot sidecars", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-voyages-"));
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
      path.join(voyagesDir, "voyage-20260622T203128Z.zip.ajrm-marine-plot.json"),
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

test("clip extraction reads gzipped capture segments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-clip-gzip-"));
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
    const captureName = "capture-2026-07-06T16-08-47-056Z.jsonl.gz";
    const capturePath = path.join(capturesDir, captureName);
    const envelopes = [
      captureEnvelope("2026-07-06T16:08:47.056Z"),
      captureEnvelope("2026-07-06T16:09:00.000Z"),
      captureEnvelope("2026-07-06T16:09:30.000Z"),
    ];
    await fs.writeFile(
      capturePath,
      zlib.gzipSync(`${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
    );

    const response = await invoke(routes, "POST", "/clips/extract", {
      file: captureName,
      from: "2026-07-06T16:08:59.000Z",
      to: "2026-07-06T16:09:01.000Z",
      clipName: "gzip-clip-test",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.clip.fileName, "gzip-clip-test.jsonl");
    assert.equal(response.body.clip.lines, 1);
    const clipPath = path.join(root, "clips", response.body.clip.fileName);
    const clipText = await fs.readFile(clipPath, "utf8");
    assert.match(clipText, /2026-07-06T16:09:00.000Z/);
  } finally {
    plugin.stop();
  }
});

test("voyage playback loads local reference capture segments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-reference-voyage-"));
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
    await writeZip(path.join(voyagesDir, "voyage-20260626T185915Z.zip"), staging, ["index.json"]);

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

test("voyage playback starts at configured warm-up when long backfill exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-warmup-voyage-"));
  const app = fakeApp();
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    replayWarmupMinutes: 1,
  });

  try {
    const capturesDir = path.join(root, "captures");
    const voyagesDir = path.join(root, "voyages");
    const captureName = "capture-2026-06-26T18-35-00-000Z.jsonl";
    const capturePath = path.join(capturesDir, `${captureName}.gz`);
    const envelopes = [
      captureEnvelope("2026-06-26T18:35:00.000Z"),
      captureEnvelope("2026-06-26T18:40:00.000Z"),
      captureEnvelope("2026-06-26T18:43:49.000Z"),
      captureEnvelope("2026-06-26T18:44:10.000Z"),
    ];
    await fs.writeFile(
      capturePath,
      zlib.gzipSync(`${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
    );

    const staging = path.join(root, "voyage-stage");
    await fs.mkdir(path.join(staging, "capture"), { recursive: true });
    await fs.writeFile(
      path.join(staging, "index.json"),
      `${JSON.stringify({
        id: "voyage-20260626T184348Z",
        startedAt: "2026-06-26T18:43:48.000Z",
        stoppedAt: "2026-06-26T18:45:00.000Z",
        captureMode: "voyage",
        captureFileMode: "reference",
        captureReferences: [
          {
            fileName: captureName,
            compressedSourcePath: capturePath,
          },
        ],
      })}\n`,
    );
    await writeZip(path.join(voyagesDir, "voyage-20260626T184348Z.zip"), staging, ["index.json"]);

    const response = await invoke(routes, "POST", "/playback/load", {
      file: "voyage-20260626T184348Z.zip",
      kind: "voyages",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.playback.cursor, 2);
    assert.equal(response.body.playback.from, "2026-06-26T18:43:49.000Z");
    assert.equal(response.body.playback.captureFrom, "2026-06-26T18:35:00.000Z");
    assert.equal(response.body.playback.warmupStartedAt, "2026-06-26T18:42:48.000Z");
    assert.equal(response.body.playback.voyageStartedAt, "2026-06-26T18:43:48.000Z");
    assert.equal(response.body.playback.includeFullBackfill, false);
  } finally {
    plugin.stop();
  }
});

test("voyage playback can include full backfill for debugging", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-full-backfill-voyage-"));
  const app = fakeApp();
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    replayWarmupMinutes: 1,
  });

  try {
    const capturesDir = path.join(root, "captures");
    const voyagesDir = path.join(root, "voyages");
    const captureName = "capture-2026-06-26T18-35-00-000Z.jsonl";
    const capturePath = path.join(capturesDir, `${captureName}.gz`);
    await fs.writeFile(
      capturePath,
      zlib.gzipSync(`${[
        captureEnvelope("2026-06-26T18:35:00.000Z"),
        captureEnvelope("2026-06-26T18:43:49.000Z"),
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`),
    );

    const staging = path.join(root, "voyage-stage");
    await fs.mkdir(path.join(staging, "capture"), { recursive: true });
    await fs.writeFile(
      path.join(staging, "index.json"),
      `${JSON.stringify({
        id: "voyage-20260626T184348Z",
        startedAt: "2026-06-26T18:43:48.000Z",
        captureFileMode: "reference",
        captureReferences: [
          {
            fileName: captureName,
            compressedSourcePath: capturePath,
          },
        ],
      })}\n`,
    );
    await writeZip(path.join(voyagesDir, "voyage-20260626T184348Z.zip"), staging, ["index.json"]);

    const response = await invoke(routes, "POST", "/playback/load", {
      file: "voyage-20260626T184348Z.zip",
      kind: "voyages",
      includeFullBackfill: true,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.playback.cursor, 0);
    assert.equal(response.body.playback.from, "2026-06-26T18:35:00.000Z");
    assert.equal(response.body.playback.captureFrom, "2026-06-26T18:35:00.000Z");
    assert.equal(response.body.playback.warmupStartedAt, null);
    assert.equal(response.body.playback.includeFullBackfill, true);
  } finally {
    plugin.stop();
  }
});

test("capture backfill ignores buffer files from before plugin start", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-old-buffer-"));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-current-buffer-"));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-power-intent-"));
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

async function writeZip(zipPath, rootDir, relativePaths) {
  const zip = new AdmZip();
  for (const relativePath of relativePaths) {
    const zipPathName = relativePath.split(path.sep).join("/");
    const data = await fs.readFile(path.join(rootDir, relativePath));
    zip.addFile(zipPathName, data);
  }
  zip.writeZip(zipPath);
}
