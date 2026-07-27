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
  createSourcePolicy,
  replayDeltaAsLiveInputs,
  replayDeltaWithPolicy,
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
  assert.match(source, /globalThis\[AJRM_MARINE_CAPTURE_API_REGISTRY\]/);
  assert.match(source, /api\.prepareVoyageDownload\(fileName\)/);
  assert.match(source, /kind === "voyages"/);
  assert.match(source, /logger-\$\{captureDownload\.fileName\}/);
  assert.match(source, /captureDownload\.cleanup\(\)/);
  assert.match(source, /cannot safely download a complete voyage bundle from Logger/);
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

test("sensor-only playback uses the exact recorded source allow-list", () => {
  const result = replayDeltaWithPolicy(
    {
      context: "vessels.self",
      updates: [
        {
          $source: "YDEN.2",
          timestamp: "2026-07-16T09:04:12.000Z",
          values: [
            { path: "navigation.position", value: { latitude: 55.8, longitude: -5.7 } },
            { path: "plugins.sensorDiagnostics", value: { old: true } },
          ],
        },
        {
          $source: "derived-data",
          timestamp: "2026-07-16T09:04:12.000Z",
          values: [
            { path: "navigation.headingTrue", value: 1.2 },
            { path: "navigation.magneticVariation", value: -0.02 },
          ],
        },
        {
          timestamp: "2026-07-16T09:04:12.000Z",
          values: [{ path: "navigation.courseOverGroundTrue", value: 1.4 }],
        },
      ],
    },
    {
      timestamp: "2026-07-27T12:00:00.000Z",
      policy: createSourcePolicy(
        "sensor-sources",
        ["YDEN.2"],
        { "YDEN.2": { updates: 1, values: 2 } },
      ),
    },
  );

  assert.equal(result.delta.updates.length, 1);
  assert.equal(result.delta.updates[0].$source, "YDEN.2");
  assert.equal(result.delta.updates[0].timestamp, "2026-07-27T12:00:00.000Z");
  assert.deepEqual(
    result.delta.updates[0].values.map((entry) => entry.path),
    ["navigation.position"],
  );
  assert.equal(result.stats.valuesSeen, 5);
  assert.equal(result.stats.valuesSent, 1);
  assert.equal(result.stats.excludedByReason.pathNamespace, 1);
  assert.equal(result.stats.excludedByReason.sourceNotAllowed, 2);
  assert.equal(result.stats.excludedByReason.missingSource, 1);
});

test("sensor-only source matching is exact and auditable", () => {
  const policy = createSourcePolicy(
    "sensor-sources",
    ["YDEN.2"],
    { "YDEN.2": { updates: 1, values: 1 } },
  );
  const result = replayDeltaWithPolicy(
    {
      updates: [
        {
          $source: "YDEN.20",
          values: [{ path: "navigation.position", value: { latitude: 1, longitude: 2 } }],
        },
      ],
    },
    { policy },
  );

  assert.equal(result.delta, null);
  assert.equal(policy.id, "strict-recorded-sensor-source-allowlist-v1");
  assert.deepEqual(policy.sensorSourceIds, ["YDEN.2"]);
  assert.equal(policy.unlistedSourceAction, "exclude");
  assert.equal(result.stats.sources["YDEN.20"].valuesExcluded, 1);
});

test("sensor prefix scan resolves long YDEN identities to an exact allow-list", () => {
  const policy = createSourcePolicy(
    "sensor-sources",
    {
      sensorSourcePrefixes: ["YDEN"],
      sensorSourceIds: ["custom-physical-compass", "missing-compass"],
    },
    {
      "YDEN.c078be001ca2785e": { updates: 100, values: 300 },
      "YDEN.cf5096ffe83083e8": { updates: 50, values: 50 },
      "YDEN.c078820010e4ae5f": { updates: 25, values: 25 },
      "custom-physical-compass": { updates: 20, values: 20 },
      "derived-data": { updates: 10, values: 10 },
    },
  );

  assert.deepEqual(policy.sensorSourcePrefixes, ["YDEN"]);
  assert.deepEqual(policy.explicitSensorSourceIds, [
    "custom-physical-compass",
    "missing-compass",
  ]);
  assert.deepEqual(policy.matchedExplicitSensorSourceIds, [
    "custom-physical-compass",
  ]);
  assert.deepEqual(policy.unmatchedExplicitSensorSourceIds, [
    "missing-compass",
  ]);
  assert.deepEqual(policy.resolvedSensorSourceIds, [
    "custom-physical-compass",
    "YDEN.c078820010e4ae5f",
    "YDEN.c078be001ca2785e",
    "YDEN.cf5096ffe83083e8",
  ]);
  assert.equal(policy.resolvedSensorSourceIds.includes("derived-data"), false);

  const replayed = replayDeltaWithPolicy(
    {
      updates: [{
        source: {
          label: "YDEN.c078be001ca2785e",
          src: "17",
          pgn: 129025,
        },
        values: [{
          path: "navigation.position",
          value: { latitude: 55.8, longitude: -5.7 },
        }],
      }],
    },
    { policy },
  );
  assert.deepEqual(replayed.delta.updates[0].source, {
    label: "YDEN.c078be001ca2785e",
    src: "17",
    pgn: 129025,
  });
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

test("playback play restarts from the loaded start after reaching the end", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-play-at-end-"));
  const capturesDir = path.join(root, "captures");
  await fs.mkdir(capturesDir, { recursive: true });
  const captureName = "capture-2026-07-07T09-00-00-000Z.jsonl";
  await fs.writeFile(
    path.join(capturesDir, captureName),
    `${[
      captureEnvelope("2026-07-07T09:00:00.000Z"),
      captureEnvelope("2026-07-07T09:00:01.000Z"),
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );

  const app = fakeApp();
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    autoAdvancePlayback: false,
    compressCompletedCaptures: false,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const loadResponse = await invoke(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
    });
    assert.equal(loadResponse.statusCode, 200);
    assert.equal(loadResponse.body.playback.cursor, 0);

    const firstPlay = await invoke(routes, "POST", "/playback/play", { rate: "max" });
    assert.equal(firstPlay.statusCode, 200);
    let lastPlayback = null;
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      lastPlayback = status.playback;
      return status.playback.lastReason === "end of capture";
    }, 1000, () => JSON.stringify(lastPlayback));

    const endedStatus = await app.ajrmMarineLoggerApi.status();
    assert.equal(endedStatus.playback.cursor, 2);
    assert.equal(endedStatus.playback.active, false);
    assert.equal(endedStatus.playback.paused, false);
    const playbackClockValues = app.messages
      .flatMap((delta) => delta.updates || [])
      .flatMap((update) => update.values || [])
      .filter((entry) => entry.path === "plugins.ajrmMarineLogger.playback")
      .map((entry) => entry.value);
    assert.equal(playbackClockValues[playbackClockValues.length - 1].active, false);

    const replayResponse = await invoke(routes, "POST", "/playback/play", { rate: "max" });
    assert.equal(replayResponse.statusCode, 200);
    assert.equal(replayResponse.body.playback.active, true);
    assert.equal(replayResponse.body.playback.cursor, 0);
    assert.equal(replayResponse.body.playback.current, "2026-07-07T09:00:00.000Z");
  } finally {
    plugin.stop();
  }
});

test("playback load can run as a pollable background job", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-async-load-"));
  const capturesDir = path.join(root, "captures");
  await fs.mkdir(capturesDir, { recursive: true });
  const captureName = "capture-2026-07-07T10-00-00-000Z.jsonl";
  await fs.writeFile(
    path.join(capturesDir, captureName),
    `${JSON.stringify(captureEnvelope("2026-07-07T10:00:00.000Z"))}\n`,
  );

  const app = fakeApp();
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: false,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const startResponse = await invoke(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      async: true,
    });

    assert.equal(startResponse.statusCode, 200);
    assert.equal(startResponse.body.ok, true);
    assert.equal(startResponse.body.load.state, "loading");
    assert.ok(startResponse.body.load.id);

    await waitFor(async () => {
      const status = await invoke(routes, "GET", "/playback/load/status", {}, {
        id: startResponse.body.load.id,
      });
      return status.body.load.state === "complete";
    });

    const complete = await invoke(routes, "GET", "/playback/load/status", {}, {
      id: startResponse.body.load.id,
    });
    assert.equal(complete.body.load.state, "complete");
    assert.equal(complete.body.load.playback.loaded, true);
    assert.equal(complete.body.load.playback.fileName, captureName);
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
    assert.equal(recording.active, true);
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
    assert.equal(recording.active, true);
    assert.equal(recording.backfilled, 1);
    assert.equal(recording.lines, 1);
  } finally {
    plugin.stop();
  }
});

test("recomputed replay capture records filtered sensor input and new plugin output without backfill", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-recomputed-"));
  const app = fakeApp();
  const originalHandleMessage = app.handleMessage;
  app.handleMessage = function handleMessage(pluginId, delta) {
    originalHandleMessage.call(app, pluginId, delta);
    app.signalk.emit("delta", delta);
    const hasPosition = (delta.updates || []).some((update) =>
      (update.values || []).some((entry) => entry.path === "navigation.position"),
    );
    if (hasPosition) {
      app.signalk.emit("delta", {
        context: "vessels.self",
        updates: [
          {
            $source: "YDEN.99",
            timestamp: new Date().toISOString(),
            values: [{ path: "navigation.depthBelowTransducer", value: 7.4 }],
          },
        ],
      });
      app.signalk.emit("delta", {
        context: "vessels.self",
        updates: [
          {
            $source: "custom-unrecorded-compass",
            timestamp: new Date().toISOString(),
            values: [{ path: "navigation.headingMagnetic", value: 1.22 }],
          },
        ],
      });
      app.signalk.emit("delta", {
        context: "vessels.self",
        updates: [
          {
            $source: "signalk-test-calculator",
            timestamp: new Date().toISOString(),
            values: [
              {
                path: "plugins.testCalculator.result",
                value: { headingTrue: 1.23 },
              },
            ],
          },
        ],
      });
    }
  };

  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    autoAdvancePlayback: false,
    compressCompletedCaptures: false,
    includePaths: ["navigation.position"],
  });

  try {
    const captureName = "capture-2026-07-16T09-04-11-907Z.jsonl";
    await fs.writeFile(
      path.join(root, "captures", captureName),
      `${JSON.stringify({
        capturedAt: "2026-07-16T09:04:12.000Z",
        delta: {
          context: "vessels.self",
          updates: [
            {
              $source: "YDEN.2",
              timestamp: "2026-07-16T09:04:12.000Z",
              values: [
                {
                  path: "navigation.position",
                  value: { latitude: 55.8, longitude: -5.7 },
                },
              ],
            },
            {
              $source: "derived-data",
              timestamp: "2026-07-16T09:04:12.000Z",
              values: [{ path: "navigation.headingTrue", value: 1.2 }],
            },
          ],
        },
      })}\n`,
    );
    const nextCaptureName = "capture-2026-07-16T09-04-13-000Z.jsonl";
    await fs.writeFile(
      path.join(root, "captures", nextCaptureName),
      `${JSON.stringify({
        capturedAt: "2026-07-16T09:04:13.000Z",
        delta: {
          context: "vessels.self",
          updates: [
            {
              $source: "YDEN.c078be001ca2785e",
              timestamp: "2026-07-16T09:04:13.000Z",
              values: [
                {
                  path: "navigation.position",
                  value: { latitude: 55.8001, longitude: -5.7001 },
                },
              ],
            },
            {
              $source: "derived-data",
              timestamp: "2026-07-16T09:04:13.000Z",
              values: [{ path: "navigation.headingTrue", value: 1.21 }],
            },
          ],
        },
      })}\n`,
    );

    const loaded = await invoke(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2", "custom-unrecorded-compass"],
    });
    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.body.playback.replayMode, "sensor-only");
    assert.deepEqual(
      loaded.body.playback.sourcePolicy.resolvedSensorSourceIds,
      ["YDEN.2"],
    );
    assert.deepEqual(
      loaded.body.playback.sourcePolicy.unmatchedExplicitSensorSourceIds,
      ["custom-unrecorded-compass"],
    );
    const started = await invoke(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-parent.zip",
    });
    assert.equal(started.body.recording.backfilled, 0);
    assert.equal(started.body.recording.kind, "recomputed-replay");

    const rejectedEarlyResultStop = await invoke(
      routes,
      "POST",
      "/playback/result-capture/stop",
    );
    assert.equal(rejectedEarlyResultStop.statusCode, 400);
    assert.match(rejectedEarlyResultStop.body.error, /reach the end/i);
    const rejectedNormalCaptureStop = await invoke(
      routes,
      "POST",
      "/capture/stop",
    );
    assert.equal(rejectedNormalCaptureStop.statusCode, 400);
    assert.match(rejectedNormalCaptureStop.body.error, /stop and build zip/i);

    const rejectedFastPlayback = await invoke(
      routes,
      "POST",
      "/playback/play",
      { rate: "max" },
    );
    assert.equal(rejectedFastPlayback.statusCode, 400);
    assert.match(rejectedFastPlayback.body.error, /locked to 1x/i);
    await invoke(routes, "POST", "/playback/play", { rate: 1 });
    const rejectedRestart = await invoke(
      routes,
      "POST",
      "/playback/play",
      { rate: 1 },
    );
    assert.equal(rejectedRestart.statusCode, 400);
    assert.match(rejectedRestart.body.error, /cannot be restarted/i);
    const rejectedPause = await invoke(routes, "POST", "/playback/pause");
    assert.equal(rejectedPause.statusCode, 400);
    assert.match(rejectedPause.body.error, /cannot be paused/i);
    const rejectedPlaybackStop = await invoke(
      routes,
      "POST",
      "/playback/stop",
    );
    assert.equal(rejectedPlaybackStop.statusCode, 400);
    assert.match(rejectedPlaybackStop.body.error, /cannot be stopped/i);
    let latestPlaybackStatus = null;
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      latestPlaybackStatus = status.playback;
      return status.playback.lastReason === "end of capture";
    }, 5000, () => JSON.stringify(latestPlaybackStatus));
    const stopped = await invoke(routes, "POST", "/playback/result-capture/stop");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const lines = (await fs.readFile(
      path.join(root, "captures", stopped.body.recording.fileName),
      "utf8",
    )).trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.replayRole), [
      "sensor-input",
      "recomputed-output",
      "sensor-input",
      "recomputed-output",
    ]);
    assert.equal(lines[0].originalCapturedAt, "2026-07-16T09:04:12.000Z");
    assert.equal(lines[0].delta.updates[0].$source, "YDEN.2");
    assert.equal(lines[0].delta.updates[0].timestamp.startsWith("2026-07-16"), false);
    assert.equal(lines[1].delta.updates[0].$source, "signalk-test-calculator");
    assert.equal(
      lines[1].delta.updates[0].values[0].path,
      "plugins.testCalculator.result",
      "recomputed outputs must bypass the normal includePaths filter",
    );
    assert.equal(lines[2].originalCapturedAt, "2026-07-16T09:04:13.000Z");
    assert.equal(lines[2].delta.updates[0].$source, "YDEN.c078be001ca2785e");
    assert.ok(
      Date.parse(lines[2].capturedAt) - Date.parse(lines[0].capturedAt) >= 800,
      "1x replay should preserve the recorded gap across capture segments",
    );
    assert.equal(stopped.body.recording.replayResult.parentVoyage, "voyage-parent.zip");
    assert.equal(
      stopped.body.recording.replayResult.originalTo,
      "2026-07-16T09:04:13.000Z",
    );
    assert.equal(stopped.body.recording.replayResult.sourceFilterStats.valuesSent, 2);
    assert.equal(stopped.body.recording.replayResult.sourceFilterStats.valuesExcluded, 2);
    assert.equal(stopped.body.recording.replayResult.rate, 1);
    assert.equal(stopped.body.recording.replayResult.coverage.complete, true);
    assert.equal(
      stopped.body.recording.replayResult.coverage.cursor,
      stopped.body.recording.replayResult.coverage.totalLines,
    );
    assert.deepEqual(
      stopped.body.recording.replayResult.sourcePolicy.resolvedSensorSourceIds,
      ["YDEN.2", "YDEN.c078be001ca2785e"],
    );
    assert.equal(
      stopped.body.recording.replayResult.sourceCatalog["YDEN.c078be001ca2785e"].values,
      1,
    );
    assert.equal(stopped.body.recording.replayResult.liveInputIsolation.valid, false);
    assert.equal(
      stopped.body.recording.replayResult.liveInputIsolation.sources["YDEN.99"],
      2,
    );
    assert.equal(
      stopped.body.recording.replayResult.liveInputIsolation.sources[
        "custom-unrecorded-compass"
      ],
      2,
      "an explicitly configured physical source must be quarantined even when absent from the parent",
    );
    const playbackClockValues = app.messages.flatMap((delta) =>
      (delta.updates || []).flatMap((update) => update.values || []),
    ).filter((entry) => entry.path === "plugins.ajrmMarineLogger.playback");
    assert.ok(playbackClockValues.length > 0);
    assert.equal(
      playbackClockValues.some((entry) =>
        entry.value?.replayMode === "sensor-only" &&
        entry.value?.capturedAt === "2026-07-16T09:04:12.000Z"),
      true,
    );
  } finally {
    plugin.stop();
  }
});

test("recomputed voyage replay pre-indexes every segment and reports cumulative coverage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-voyage-playlist-"));
  const app = fakeApp();
  const prepared = [];
  app.ajrmMarineLoggerTestHooks = {
    calculationFlushQuietMs: 30,
    calculationFlushMaxMs: 100,
    async beforePreparePlaybackSegment({ name }) {
      prepared.push({ name, at: Date.now() });
      if (name.includes("09-00-01")) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
  };
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    autoAdvancePlayback: false,
    compressCompletedCaptures: false,
  });

  try {
    const staging = path.join(root, "voyage-playlist-stage");
    const captureDirectory = path.join(staging, "capture");
    await fs.mkdir(captureDirectory, { recursive: true });
    const firstName = "capture-2026-07-16T09-00-00-000Z.jsonl";
    const secondName = "capture-2026-07-16T09-00-01-000Z.jsonl";
    await fs.writeFile(
      path.join(captureDirectory, firstName),
      `${JSON.stringify(sensorEnvelope(
        "2026-07-16T09:00:00.000Z",
        "YDEN.2",
      ))}\n`,
    );
    await fs.writeFile(
      path.join(captureDirectory, secondName),
      `${JSON.stringify(sensorEnvelope(
        "2026-07-16T09:00:00.250Z",
        "YDEN.c078be001ca2785e",
      ))}\n`,
    );
    await fs.writeFile(
      path.join(staging, "index.json"),
      `${JSON.stringify({
        id: "voyage-20260716T090000Z",
        startedAt: "2026-07-16T09:00:00.000Z",
        captureFileMode: "portable",
      })}\n`,
    );
    const voyageName = "voyage-20260716T090000Z.zip";
    await writeZip(
      path.join(root, "voyages", voyageName),
      staging,
      ["index.json", path.join("capture", firstName), path.join("capture", secondName)],
    );

    const loadStartedMs = Date.now();
    const loaded = await invoke(routes, "POST", "/playback/load", {
      file: voyageName,
      kind: "voyages",
      mode: "sensor-sources",
      sensorSourcePrefixes: ["YDEN"],
    });
    const loadElapsedMs = Date.now() - loadStartedMs;
    assert.equal(loaded.statusCode, 200);
    assert.ok(loadElapsedMs >= 220, "slow second-segment preparation must finish during load");
    assert.deepEqual(prepared.map((entry) => entry.name), [firstName, secondName]);
    assert.equal(loaded.body.playback.totalLines, 2);
    assert.equal(loaded.body.playback.coverage.loadedSegmentsTotal, 2);
    assert.equal(loaded.body.playback.coverage.complete, false);
    assert.deepEqual(
      loaded.body.playback.sourcePolicy.resolvedSensorSourceIds,
      ["YDEN.2", "YDEN.c078be001ca2785e"],
    );

    const started = await invoke(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: voyageName,
    });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.recording.replayResult.coverage.segmentsTotal, 2);
    assert.equal(prepared.length, 2, "result start must reuse the pre-indexed voyage");

    await invoke(routes, "POST", "/playback/play", { rate: 1 });
    let betweenSegments = null;
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      if (status.playback.cursor !== 1) return false;
      betweenSegments = status.playback;
      return true;
    }, 1000);
    assert.equal(betweenSegments.coverage.complete, false);
    assert.equal(betweenSegments.coverage.segmentsCompleted, 1);
    assert.equal(betweenSegments.coverage.segmentsTotal, 2);

    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      return status.playback.lastReason === "end of capture";
    }, 1500);
    const stopped = await invoke(routes, "POST", "/playback/result-capture/stop");
    assert.equal(stopped.statusCode, 200);
    const coverage = stopped.body.recording.replayResult.coverage;
    assert.equal(coverage.complete, true);
    assert.equal(coverage.cursor, 2);
    assert.equal(coverage.totalLines, 2);
    assert.equal(coverage.segmentsCompleted, 2);
    assert.equal(coverage.segmentsTotal, 2);
    assert.equal(coverage.preparedComplete, true);
    assert.equal(coverage.inputComplete, true);
    assert.equal(coverage.resultSegmentsComplete, true);
    const resultSegments = stopped.body.recording.replayResult.resultSegments;
    assert.equal(resultSegments.complete, true);
    assert.equal(resultSegments.segmentsTotal, 1);
    assert.equal(resultSegments.segmentsFinalized, 1);
    assert.equal(resultSegments.segments[0].available, true);
    assert.ok(resultSegments.segments[0].bytes > 0);

    const lines = (await fs.readFile(
      path.join(root, "captures", stopped.body.recording.fileName),
      "utf8",
    )).trim().split("\n").map(JSON.parse);
    const sensorInputs = lines.filter((line) => line.replayRole === "sensor-input");
    assert.equal(sensorInputs.length, 2);
    const boundaryElapsedMs =
      Date.parse(sensorInputs[1].capturedAt) - Date.parse(sensorInputs[0].capturedAt);
    assert.ok(boundaryElapsedMs >= 180, "1x replay must retain source time at the boundary");
    assert.ok(
      boundaryElapsedMs < 400,
      `pre-indexed boundary must not include the 250 ms preparation delay (${boundaryElapsedMs} ms)`,
    );
  } finally {
    plugin.stop();
  }
});

test("forced-short rotation declares every finalized recomputed result segment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-result-manifest-"));
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    captureSegmentMs: 20,
    calculationFlushQuietMs: 15,
    calculationFlushMaxMs: 50,
  };
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    autoAdvancePlayback: false,
    compressCompletedCaptures: true,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const captureName = "capture-2026-07-16T09-30-00-000Z.jsonl";
    const envelopes = [
      sensorEnvelope("2026-07-16T09:30:00.000Z", "YDEN.2"),
      sensorEnvelope("2026-07-16T09:30:00.050Z", "YDEN.2"),
      sensorEnvelope("2026-07-16T09:30:00.100Z", "YDEN.2"),
    ];
    await fs.writeFile(
      path.join(root, "captures", captureName),
      `${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await invoke(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invoke(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-rotation-parent.zip",
    });
    await invoke(routes, "POST", "/playback/play", { rate: 1 });
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      return status.playback.lastReason === "end of capture";
    }, 2000);

    const stopped = await invoke(routes, "POST", "/playback/result-capture/stop");
    assert.equal(stopped.statusCode, 200);
    const replayResult = stopped.body.recording.replayResult;
    assert.equal(replayResult.coverage.complete, true);
    assert.equal(replayResult.coverage.resultSegmentsComplete, true);
    assert.equal(replayResult.resultSegments.complete, true);
    assert.equal(replayResult.resultSegments.segmentsTotal, 3);
    assert.equal(replayResult.resultSegments.segmentsFinalized, 3);
    assert.equal(replayResult.resultSegments.lines, 3);
    for (const segment of replayResult.resultSegments.segments) {
      assert.equal(segment.finalized, true);
      assert.equal(segment.available, true);
      assert.equal(segment.lines, 1);
      assert.equal(segment.compressed, true);
      assert.match(segment.fileName, /\.jsonl\.gz$/);
      assert.equal(
        (await fs.stat(path.join(root, "captures", segment.fileName))).size,
        segment.bytes,
      );
    }
  } finally {
    plugin.stop();
  }
});

test("rotated recomputed result manifest makes coverage incomplete when an earlier segment is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-result-rotation-"));
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    captureSegmentMs: 20,
    calculationFlushQuietMs: 15,
    calculationFlushMaxMs: 50,
  };
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    autoAdvancePlayback: false,
    compressCompletedCaptures: false,
  });

  try {
    const captureName = "capture-2026-07-16T10-00-00-000Z.jsonl";
    const envelopes = [
      sensorEnvelope("2026-07-16T10:00:00.000Z", "YDEN.2"),
      sensorEnvelope("2026-07-16T10:00:00.050Z", "YDEN.2"),
      sensorEnvelope("2026-07-16T10:00:00.100Z", "YDEN.2"),
    ];
    await fs.writeFile(
      path.join(root, "captures", captureName),
      `${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await invoke(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invoke(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-rotation-parent.zip",
    });
    await invoke(routes, "POST", "/playback/play", { rate: 1 });

    let activeManifest = null;
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      activeManifest = status.recording?.replayResult?.resultSegments;
      return (
        status.playback.lastReason === "end of capture" &&
        activeManifest?.segmentsTotal === 3 &&
        activeManifest.segments.filter((segment) => segment.finalized).length >= 2
      );
    }, 2000, () => JSON.stringify(activeManifest));
    const firstSegment = activeManifest.segments[0];
    assert.equal(firstSegment.finalized, true);
    await fs.unlink(path.join(root, "captures", firstSegment.fileName));

    const stopped = await invoke(routes, "POST", "/playback/result-capture/stop");
    assert.equal(stopped.statusCode, 200);
    const replayResult = stopped.body.recording.replayResult;
    assert.equal(replayResult.resultSegments.segmentsTotal, 3);
    assert.equal(replayResult.resultSegments.segmentsFinalized, 3);
    assert.equal(replayResult.resultSegments.complete, false);
    assert.equal(replayResult.resultSegments.segments[0].available, false);
    assert.match(
      replayResult.resultSegments.segments[0].error,
      /missing or changed/i,
    );
    assert.equal(replayResult.coverage.inputComplete, true);
    assert.equal(replayResult.coverage.resultSegmentsComplete, false);
    assert.equal(
      replayResult.coverage.complete,
      false,
      "input playback coverage must not conceal a missing rotated result segment",
    );
  } finally {
    plugin.stop();
  }
});

test("recomputed replay flush extends for output quiet time but stops at its maximum", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-flush-debounce-"));
  const app = fakeApp();
  const outputTimers = [];
  let outputScheduled = false;
  const originalHandleMessage = app.handleMessage;
  app.handleMessage = function handleMessage(pluginId, delta) {
    originalHandleMessage.call(app, pluginId, delta);
    const hasPosition = (delta.updates || []).some((update) =>
      (update.values || []).some((entry) => entry.path === "navigation.position"),
    );
    if (!hasPosition || outputScheduled) return;
    outputScheduled = true;
    for (const delayMs of [50, 100, 150, 200, 250, 300]) {
      outputTimers.push(setTimeout(() => {
        app.signalk.emit("delta", {
          context: "vessels.self",
          updates: [{
            $source: "signalk-test-delayed-calculator",
            timestamp: new Date().toISOString(),
            values: [{
              path: "plugins.testDelayedCalculator.result",
              value: { delayMs },
            }],
          }],
        });
      }, delayMs));
    }
  };
  app.ajrmMarineLoggerTestHooks = {
    calculationFlushQuietMs: 80,
    calculationFlushMaxMs: 180,
  };
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    autoAdvancePlayback: false,
    compressCompletedCaptures: false,
  });

  try {
    const captureName = "capture-2026-07-16T11-00-00-000Z.jsonl";
    await fs.writeFile(
      path.join(root, "captures", captureName),
      `${JSON.stringify(sensorEnvelope(
        "2026-07-16T11:00:00.000Z",
        "YDEN.2",
      ))}\n`,
    );
    await invoke(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invoke(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-flush-parent.zip",
    });
    await invoke(routes, "POST", "/playback/play", { rate: 1 });
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      return status.playback.lastReason === "end of capture";
    });

    const stopStartedMs = Date.now();
    const stopped = await invoke(routes, "POST", "/playback/result-capture/stop");
    const stopElapsedMs = Date.now() - stopStartedMs;
    assert.ok(
      stopElapsedMs >= 140,
      `captured outputs should extend the 80 ms quiet period (${stopElapsedMs} ms)`,
    );
    assert.ok(
      stopElapsedMs < 260,
      `continuous outputs must be bounded by the 180 ms maximum (${stopElapsedMs} ms)`,
    );
    const flush = stopped.body.recording.replayResult.calculationFlush;
    assert.equal(flush.quietPeriodMs, 80);
    assert.equal(flush.maximumDurationMs, 180);
    assert.ok(flush.outputsDuringQuietPeriod >= 2);
  } finally {
    for (const timer of outputTimers) clearTimeout(timer);
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
  const messages = [];
  return {
    signalk: new EventEmitter(),
    messages,
    setPluginStatus() {},
    handleMessage(_pluginId, delta) {
      messages.push(delta);
    },
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

async function invoke(routes, method, route, body = {}, query = {}) {
  let statusCode = 200;
  let payload;
  const handler = routes.get(`${method} ${route}`);
  assert.ok(handler, `expected route ${method} ${route}`);
  await handler(
    { body, query },
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

async function waitFor(predicate, timeoutMs = 1000, describe = () => "") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for condition ${describe()}`);
}

function captureEnvelope(timestamp) {
  return {
    capturedAt: timestamp,
    delta: captureDelta(timestamp),
  };
}

function sensorEnvelope(timestamp, sourceId) {
  return {
    capturedAt: timestamp,
    delta: {
      context: "vessels.self",
      updates: [{
        $source: sourceId,
        timestamp,
        values: [{
          path: "navigation.position",
          value: { latitude: 55.8, longitude: -5.7 },
        }],
      }],
    },
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
