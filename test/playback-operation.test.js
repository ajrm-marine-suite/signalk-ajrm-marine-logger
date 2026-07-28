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
      pacingAnchorMs: 1000,
      rate: 10,
      pacingNowMs: 2500,
    }),
    500,
  );
});

test("numeric playback rate stops delaying once playback is behind schedule", () => {
  assert.equal(
    calculatePlaybackDelayMs({
      nextSourceMs: 120000,
      sourceAnchorMs: 100000,
      pacingAnchorMs: 1000,
      rate: 20,
      pacingNowMs: 2500,
    }),
    0,
  );
});

test("max playback never applies timing delay", () => {
  assert.equal(
    calculatePlaybackDelayMs({
      nextSourceMs: 120000,
      sourceAnchorMs: 100000,
      pacingAnchorMs: 1000,
      rate: "max",
      pacingNowMs: 1000,
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

test("all replay modes replace historical navigation datetime with the replay wall clock", () => {
  const replayTimestamp = "2026-07-28T10:30:00.000Z";
  for (const mode of ["standard", "sensor-sources"]) {
    const policy = createSourcePolicy(
      mode,
      ["YDEN.2"],
      { "YDEN.2": { updates: 1, values: 2 } },
    );
    const result = replayDeltaWithPolicy(
      {
        context: "vessels.self",
        updates: [{
          $source: "YDEN.2",
          timestamp: "2026-07-14T14:26:20.17180Z",
          values: [
            {
              path: "navigation.datetime",
              value: "2026-07-14T14:26:20.17180Z",
            },
            {
              path: "navigation.position",
              value: { latitude: 55.8, longitude: -5.7 },
            },
          ],
        }],
      },
      { timestamp: replayTimestamp, policy },
    );

    assert.equal(result.delta.updates[0].timestamp, replayTimestamp);
    assert.equal(
      result.delta.updates[0].values.find((entry) =>
        entry.path === "navigation.datetime",
      ).value,
      replayTimestamp,
    );
    assert.equal(result.stats.valuesTransformed, 1);
    assert.equal(
      result.stats.transformations[
        "navigation.datetime:replace-with-replay-wall-clock"
      ],
      1,
    );
    assert.deepEqual(policy.valueTransforms, [{
      id: "navigation.datetime:replace-with-replay-wall-clock",
      path: "navigation.datetime",
      action: "replace-with-replay-wall-clock",
      reason: "prevent historical replay data from changing the host system clock",
    }]);
  }
});

test("root replay values also refresh nested navigation datetime without changing their shape", () => {
  const replayTimestamp = "2026-07-28T10:31:00.000Z";
  const result = replayDeltaWithPolicy(
    {
      updates: [{
        $source: "YDEN.2",
        values: [{
          path: "",
          value: {
            navigation: {
              datetime: {
                value: "2026-07-14T14:26:20.17180Z",
                timestamp: "2026-07-14T14:26:20.17180Z",
                $source: "YDEN.2",
              },
              position: {
                value: { latitude: 55.8, longitude: -5.7 },
              },
            },
          },
        }],
      }],
    },
    {
      timestamp: replayTimestamp,
      policy: createSourcePolicy(
        "sensor-sources",
        ["YDEN.2"],
        { "YDEN.2": { updates: 1, values: 1 } },
      ),
    },
  );

  assert.deepEqual(
    result.delta.updates[0].values[0].value.navigation.datetime,
    {
      value: replayTimestamp,
      timestamp: replayTimestamp,
      $source: "YDEN.2",
    },
  );
  assert.equal(result.stats.valuesTransformed, 1);
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

test("recomputed replay retains every pre-indexed compressed capture cache file", async () => {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "ajrm-marine-logger-compressed-playlist-",
  ));
  const app = fakeApp();
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    autoAdvancePlayback: true,
    compressCompletedCaptures: false,
  });

  try {
    const capturesDir = path.join(root, "captures");
    const captures = [
      {
        name: "capture-2026-07-13T21-23-54-648Z.jsonl.gz",
        envelope: sensorEnvelope("2026-07-13T21:23:54.648Z", "YDEN.2"),
      },
      {
        name: "capture-2026-07-13T21-23-55-648Z.jsonl.gz",
        envelope: sensorEnvelope(
          "2026-07-13T21:23:54.698Z",
          "YDEN.c078be001ca2785e",
        ),
      },
    ];
    for (const capture of captures) {
      await fs.writeFile(
        path.join(capturesDir, capture.name),
        zlib.gzipSync(`${JSON.stringify(capture.envelope)}\n`),
      );
    }

    const loaded = await invoke(routes, "POST", "/playback/load", {
      file: captures[0].name,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourcePrefixes: ["YDEN"],
    });
    assert.equal(loaded.statusCode, 200);

    const started = await invoke(
      routes,
      "POST",
      "/playback/result-capture/start",
      {},
    );
    assert.equal(started.statusCode, 200);
    const ready = await app.ajrmMarineLoggerApi.status();
    assert.equal(ready.playback.coverage.loadedSegmentsTotal, 2);
    const cacheFiles = await fs.readdir(path.join(
      root,
      "voyage-replay-cache",
      "compressed-captures",
    ));
    assert.equal(
      cacheFiles.filter((name) => name.endsWith(".jsonl")).length,
      2,
    );

    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      return status.playback.lastReason === "end of capture";
    });
    const completed = await app.ajrmMarineLoggerApi.status();
    assert.equal(completed.playback.cursor, 2);
    assert.equal(completed.playback.lastError, null);
  } finally {
    plugin.stop();
  }
});

test("status reports one named metadata error for unchanged corrupt gzip and retries after replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-metadata-error-"));
  const app = fakeApp();
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: false,
  });

  try {
    const captureName = "capture-2026-07-28T10-38-20-000Z.jsonl.gz";
    const capturePath = path.join(root, "captures", captureName);
    await fs.writeFile(capturePath, Buffer.from("not a readable gzip capture"));

    const pending = await app.ajrmMarineLoggerApi.status();
    assert.equal(
      pending.captures.find((item) => item.fileName === captureName).metadataPending,
      true,
    );

    let failedStatus = null;
    await waitFor(async () => {
      failedStatus = await app.ajrmMarineLoggerApi.status();
      return Boolean(
        failedStatus.captures.find((item) => item.fileName === captureName)?.metadataError,
      );
    });
    const failedItem = failedStatus.captures.find((item) => item.fileName === captureName);
    assert.match(failedItem.metadataError, /header|gzip|block/i);
    assert.equal(failedItem.metadataPending, false);
    assert.equal(
      failedStatus.recentEvents.filter((event) =>
        event.message.includes(`metadata generation failed for ${captureName}`),
      ).length,
      1,
    );

    for (let index = 0; index < 4; index += 1) {
      await app.ajrmMarineLoggerApi.status();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const unchangedStatus = await app.ajrmMarineLoggerApi.status();
    assert.equal(
      unchangedStatus.recentEvents.filter((event) =>
        event.message.includes(`metadata generation failed for ${captureName}`),
      ).length,
      1,
      "an unchanged corrupt file must not be rescanned and relogged on every status refresh",
    );

    const envelope = captureEnvelope("2026-07-28T10:40:00.000Z");
    await fs.writeFile(
      capturePath,
      zlib.gzipSync(`${JSON.stringify(envelope)}\n`),
    );
    await app.ajrmMarineLoggerApi.status();
    let recoveredStatus = null;
    await waitFor(async () => {
      recoveredStatus = await app.ajrmMarineLoggerApi.status();
      const item = recoveredStatus.captures.find((candidate) =>
        candidate.fileName === captureName,
      );
      return item?.lines === 1 && !item.metadataError;
    });
    const recoveredItem = recoveredStatus.captures.find((item) =>
      item.fileName === captureName,
    );
    assert.equal(recoveredItem.metadataPending, false);
    assert.equal(recoveredItem.metadataError, null);
  } finally {
    plugin.stop();
  }
});

test("startup recovery ignores captures created after its immutable snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-startup-race-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const stalePath = path.join(
    captures,
    "capture-2026-07-27T10-00-00-000Z.jsonl",
  );
  const changedPath = path.join(
    captures,
    "capture-2026-07-27T11-00-00-000Z.jsonl",
  );
  const completedPath = path.join(
    captures,
    "capture-2026-07-27T12-00-00-000Z.jsonl",
  );
  await fs.writeFile(stalePath, "");
  await fs.writeFile(changedPath, "");
  await fs.writeFile(
    completedPath,
    `${JSON.stringify(sensorEnvelope(
      "2026-07-27T12:00:00.000Z",
      "YDEN.2",
    ))}\n`,
  );

  let releaseStartupRecovery;
  const startupRecoveryGate = new Promise((resolve) => {
    releaseStartupRecovery = resolve;
  });
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    beforeStartupRecoveryCleanup() {
      return startupRecoveryGate;
    },
  };
  const routes = new Map();
  const plugin = startPlugin(app);
  plugin.registerWithRouter(routerMap(routes));
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    const newName = "capture-2026-07-28T10-00-00-000Z.jsonl";
    const newPath = path.join(captures, newName);
    await fs.writeFile(newPath, "");
    const changedText = `${JSON.stringify(sensorEnvelope(
      "2026-07-27T11:00:00.000Z",
      "YDEN.2",
    ))}\n`;
    await fs.writeFile(changedPath, changedText);
    releaseStartupRecovery();

    await waitFor(async () => {
      const staleStats = await fs.stat(stalePath).catch(() => null);
      const compressedStats = await fs.stat(`${completedPath}.gz`).catch(() => null);
      const completedStats = await fs.stat(completedPath).catch(() => null);
      return (
        staleStats === null &&
        compressedStats?.isFile() &&
        completedStats === null
      );
    });
    await assert.rejects(fs.stat(completedPath), /ENOENT/);
    assert.equal(await fs.readFile(changedPath, "utf8"), changedText);
    await assert.rejects(fs.stat(`${changedPath}.gz`), /ENOENT/);
    const newEmptyStats = await fs.stat(newPath);
    assert.equal(newEmptyStats.size, 0);
    await assert.rejects(fs.stat(`${newPath}.gz`), /ENOENT/);

    const envelope = sensorEnvelope(
      "2026-07-28T10:00:00.000Z",
      "YDEN.2",
    );
    await fs.writeFile(newPath, `${JSON.stringify(envelope)}\n`);
    const loaded = await invoke(routes, "POST", "/playback/load", {
      file: newName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    assert.equal(loaded.statusCode, 200);
    assert.equal(loaded.body.ok, true);
    assert.equal(loaded.body.playback.loaded, true);
  } finally {
    releaseStartupRecovery();
    plugin.stop();
  }
});

test("plugin stop cancels gated startup recovery before a later restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-recovery-stop-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const emptyPath = path.join(
    captures,
    "capture-2026-07-27T13-00-00-000Z.jsonl",
  );
  const completedPath = path.join(
    captures,
    "capture-2026-07-27T14-00-00-000Z.jsonl",
  );
  const completedText = `${JSON.stringify(
    sensorEnvelope("2026-07-27T14:00:00.000Z", "YDEN.2"),
  )}\n`;
  await fs.writeFile(emptyPath, "");
  await fs.writeFile(completedPath, completedText);

  let releaseStartupRecovery;
  const startupRecoveryGate = new Promise((resolve) => {
    releaseStartupRecovery = resolve;
  });
  let firstRecoveryFinished = false;
  let firstRecoveryCancelled = false;
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    beforeStartupRecoveryCleanup() {
      return startupRecoveryGate;
    },
    afterStartupRecoveryCleanup({ cancelled }) {
      firstRecoveryCancelled = cancelled;
      firstRecoveryFinished = true;
    },
  };
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    plugin.stop();
    releaseStartupRecovery();
    await waitFor(() => firstRecoveryFinished);
    assert.equal(firstRecoveryCancelled, true);
    assert.equal((await fs.stat(emptyPath)).size, 0);
    assert.equal(await fs.readFile(completedPath, "utf8"), completedText);
    await assert.rejects(fs.stat(`${completedPath}.gz`), /ENOENT/);

    let secondRecoveryFinished = false;
    app.ajrmMarineLoggerTestHooks = {
      afterStartupRecoveryCleanup({ cancelled }) {
        assert.equal(cancelled, false);
        secondRecoveryFinished = true;
      },
    };
    plugin.start({
      logDirectory: root,
      autoStartCapture: false,
      compressCompletedCaptures: true,
    });
    await waitFor(() => secondRecoveryFinished);
    await assert.rejects(fs.stat(emptyPath), /ENOENT/);
    await assert.rejects(fs.stat(completedPath), /ENOENT/);
    assert.equal(
      zlib.gunzipSync(await fs.readFile(`${completedPath}.gz`)).toString("utf8"),
      completedText,
    );
  } finally {
    releaseStartupRecovery();
    plugin.stop();
  }
});

test("startup compression quarantines corrupt existing gzip and preserves its plain source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-existing-gzip-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const fileName = "capture-2026-07-28T10-00-00-000Z.jsonl";
  const plainPath = path.join(captures, fileName);
  const gzipPath = `${plainPath}.gz`;
  const plainText = `${JSON.stringify(captureEnvelope("2026-07-28T10:00:00.000Z"))}\n`;
  await fs.writeFile(plainPath, plainText);
  await fs.writeFile(gzipPath, Buffer.from("invalid existing gzip"));

  const app = fakeApp();
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    await waitFor(async () => {
      const names = await fs.readdir(captures);
      return names.some((name) => name.startsWith(`${fileName}.gz.corrupt`));
    });
    assert.equal(await fs.readFile(plainPath, "utf8"), plainText);
    await assert.rejects(fs.stat(gzipPath), /ENOENT/);
    const names = await fs.readdir(captures);
    assert.equal(
      names.some((name) => name.startsWith(`${fileName}.gz.corrupt`)),
      true,
    );
  } finally {
    plugin.stop();
  }
});

test("startup compression retains a valid gzip that differs from the plain source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-gzip-conflict-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const fileName = "capture-2026-07-28T10-05-00-000Z.jsonl";
  const plainPath = path.join(captures, fileName);
  const gzipPath = `${plainPath}.gz`;
  const firstLine = `${JSON.stringify(
    sensorEnvelope("2026-07-28T10:05:00.000Z", "YDEN.2"),
  )}\n`;
  const plainText = `${firstLine}${JSON.stringify(
    sensorEnvelope("2026-07-28T10:05:01.000Z", "YDEN.2"),
  )}\n`;
  await fs.writeFile(plainPath, plainText);
  await fs.writeFile(gzipPath, zlib.gzipSync(firstLine));

  let recoveryFinished = false;
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    afterStartupRecoveryCleanup() {
      recoveryFinished = true;
    },
  };
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    await waitFor(() => recoveryFinished);
    assert.equal(await fs.readFile(plainPath, "utf8"), plainText);
    assert.equal(
      zlib.gunzipSync(await fs.readFile(gzipPath)).toString("utf8"),
      firstLine,
    );
    const status = await app.ajrmMarineLoggerApi.status();
    assert.equal(
      status.recentEvents.some((event) =>
        event.event === "capture-compression-conflict"),
      true,
    );
  } finally {
    plugin.stop();
  }
});

test("startup compression removes a plain duplicate only when gzip content matches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-gzip-match-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const fileName = "capture-2026-07-28T10-07-00-000Z.jsonl";
  const plainPath = path.join(captures, fileName);
  const gzipPath = `${plainPath}.gz`;
  const plainText = `${JSON.stringify(
    sensorEnvelope("2026-07-28T10:07:00.000Z", "YDEN.2"),
  )}\n`;
  await fs.writeFile(plainPath, plainText);
  await fs.writeFile(gzipPath, zlib.gzipSync(plainText));

  let recoveryFinished = false;
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    afterStartupRecoveryCleanup() {
      recoveryFinished = true;
    },
  };
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    await waitFor(() => recoveryFinished);
    await assert.rejects(fs.stat(plainPath), /ENOENT/);
    assert.equal(
      zlib.gunzipSync(await fs.readFile(gzipPath)).toString("utf8"),
      plainText,
    );
  } finally {
    plugin.stop();
  }
});

test("compression validates temporary gzip before deleting the plain source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-new-gzip-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const fileName = "capture-2026-07-28T10-10-00-000Z.jsonl";
  const plainPath = path.join(captures, fileName);
  const plainText = `${JSON.stringify(captureEnvelope("2026-07-28T10:10:00.000Z"))}\n`;
  await fs.writeFile(plainPath, plainText);

  const app = fakeApp();
  let temporaryCorrupted = false;
  let recoveryFinished = false;
  app.ajrmMarineLoggerTestHooks = {
    async afterCompressTemporaryFile({ temporaryPath }) {
      temporaryCorrupted = true;
      await fs.writeFile(temporaryPath, Buffer.from("corrupt generated gzip"));
    },
    afterStartupRecoveryCleanup() {
      recoveryFinished = true;
    },
  };
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    await waitFor(() => temporaryCorrupted && recoveryFinished);
    assert.equal(await fs.readFile(plainPath, "utf8"), plainText);
    await assert.rejects(fs.stat(`${plainPath}.gz`), /ENOENT/);
    await assert.rejects(fs.stat(`${plainPath}.gz.tmp`), /ENOENT/);
  } finally {
    plugin.stop();
  }
});

test("startup compression preserves a source changed while gzip is built", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-source-change-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const fileName = "capture-2026-07-28T10-15-00-000Z.jsonl";
  const plainPath = path.join(captures, fileName);
  const originalText = `${JSON.stringify(
    sensorEnvelope("2026-07-28T10:15:00.000Z", "YDEN.2"),
  )}\n`;
  const changedText = `${originalText}${JSON.stringify(
    sensorEnvelope("2026-07-28T10:15:01.000Z", "YDEN.2"),
  )}\n`;
  await fs.writeFile(plainPath, originalText);

  let sourceChanged = false;
  let recoveryFinished = false;
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    async afterCompressTemporaryFile({ sourcePath }) {
      await fs.writeFile(sourcePath, changedText);
      sourceChanged = true;
    },
    afterStartupRecoveryCleanup() {
      recoveryFinished = true;
    },
  };
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    await waitFor(() => sourceChanged && recoveryFinished);
    assert.equal(await fs.readFile(plainPath, "utf8"), changedText);
    await assert.rejects(fs.stat(`${plainPath}.gz`), /ENOENT/);
    await assert.rejects(fs.stat(`${plainPath}.gz.tmp`), /ENOENT/);
  } finally {
    plugin.stop();
  }
});

test("startup recovery does not overwrite a compression temp changed after snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-temp-change-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const fileName = "capture-2026-07-28T10-20-00-000Z.jsonl";
  const plainPath = path.join(captures, fileName);
  const temporaryPath = `${plainPath}.gz.tmp`;
  const plainText = `${JSON.stringify(
    sensorEnvelope("2026-07-28T10:20:00.000Z", "YDEN.2"),
  )}\n`;
  await fs.writeFile(plainPath, plainText);
  await fs.writeFile(temporaryPath, "old incomplete gzip");

  let releaseStartupRecovery;
  const startupRecoveryGate = new Promise((resolve) => {
    releaseStartupRecovery = resolve;
  });
  let recoveryFinished = false;
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    beforeStartupRecoveryCleanup() {
      return startupRecoveryGate;
    },
    afterStartupRecoveryCleanup() {
      recoveryFinished = true;
    },
  };
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    const changedTemporaryText = "changed after immutable startup snapshot";
    await fs.writeFile(temporaryPath, changedTemporaryText);
    releaseStartupRecovery();
    await waitFor(() => recoveryFinished);
    assert.equal(await fs.readFile(plainPath, "utf8"), plainText);
    assert.equal(
      await fs.readFile(temporaryPath, "utf8"),
      changedTemporaryText,
    );
    await assert.rejects(fs.stat(`${plainPath}.gz`), /ENOENT/);
  } finally {
    releaseStartupRecovery();
    plugin.stop();
  }
});

test("startup compression does not overwrite a gzip published after snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-gzip-publish-"));
  const captures = path.join(root, "captures");
  await fs.mkdir(captures, { recursive: true });
  const fileName = "capture-2026-07-28T10-25-00-000Z.jsonl";
  const plainPath = path.join(captures, fileName);
  const gzipPath = `${plainPath}.gz`;
  const plainText = `${JSON.stringify(
    sensorEnvelope("2026-07-28T10:25:00.000Z", "YDEN.2"),
  )}\n`;
  const independentlyPublishedText = `${JSON.stringify(
    sensorEnvelope("2026-07-28T10:24:59.000Z", "YDEN.other"),
  )}\n`;
  await fs.writeFile(plainPath, plainText);

  let recoveryFinished = false;
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    async afterCompressTemporaryFile({ compressedPath }) {
      await fs.writeFile(
        compressedPath,
        zlib.gzipSync(independentlyPublishedText),
      );
    },
    afterStartupRecoveryCleanup() {
      recoveryFinished = true;
    },
  };
  const plugin = startPlugin(app);
  plugin.start({
    logDirectory: root,
    autoStartCapture: false,
    compressCompletedCaptures: true,
  });

  try {
    await waitFor(() => recoveryFinished);
    assert.equal(await fs.readFile(plainPath, "utf8"), plainText);
    assert.equal(
      zlib.gunzipSync(await fs.readFile(gzipPath)).toString("utf8"),
      independentlyPublishedText,
    );
    await assert.rejects(fs.stat(`${gzipPath}.tmp`), /ENOENT/);
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

test("historical navigation datetime is replayed as current time and does not stop subsequent sensor input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-datetime-replay-"));
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    calculationFlushQuietMs: 20,
    calculationFlushMaxMs: 60,
  };
  const originalHandleMessage = app.handleMessage;
  app.handleMessage = function handleMessage(pluginId, delta) {
    const datetimeValue = (delta.updates || []).flatMap((update) =>
      update.values || [],
    ).find((entry) => entry.path === "navigation.datetime")?.value;
    if (
      typeof datetimeValue === "string" &&
      datetimeValue.startsWith("2026-07-14")
    ) {
      throw new Error("historical navigation.datetime would move the host clock");
    }
    originalHandleMessage.call(app, pluginId, delta);
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
    const firstCapturedAt = "2026-07-14T14:26:20.171Z";
    const secondCapturedAt = "2026-07-14T14:26:20.220Z";
    const captureName = "capture-2026-07-14T14-26-20-171Z.jsonl";
    await fs.writeFile(
      path.join(root, "captures", captureName),
      `${[
        {
          capturedAt: firstCapturedAt,
          delta: {
            context: "vessels.self",
            updates: [{
              $source: "YDEN.2",
              timestamp: firstCapturedAt,
              values: [{
                path: "navigation.datetime",
                value: "2026-07-14T14:26:20.17180Z",
              }],
            }],
          },
        },
        sensorEnvelope(secondCapturedAt, "YDEN.2"),
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await invokeOk(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invokeOk(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-historical-datetime-parent.zip",
    });
    app.ajrmMarineLoggerApi.startPlayback(1);

    let finishedStatus = null;
    await waitFor(async () => {
      finishedStatus = await app.ajrmMarineLoggerApi.status();
      return finishedStatus.playback.lastReason === "end of capture";
    });
    assert.equal(finishedStatus.playback.cursor, 2);
    assert.equal(finishedStatus.playback.lastError, null);
    assert.equal(
      finishedStatus.playback.sourceFilterStats.valuesTransformed,
      1,
    );
    assert.equal(
      finishedStatus.playback.sourceFilterStats.transformations[
        "navigation.datetime:replace-with-replay-wall-clock"
      ],
      1,
    );

    const stopped = await invoke(routes, "POST", "/playback/result-capture/stop");
    assert.equal(stopped.statusCode, 200);
    const resultPath = path.join(root, "captures", stopped.body.recording.fileName);
    const resultLines = (await fs.readFile(resultPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const sensorInputs = resultLines.filter((entry) => entry.replayRole === "sensor-input");
    assert.equal(sensorInputs.length, 2);
    assert.equal(sensorInputs[0].originalCapturedAt, firstCapturedAt);
    assert.equal(
      sensorInputs[0].delta.updates[0].values[0].value,
      sensorInputs[0].capturedAt,
      "navigation.datetime must use the same replay wall time as the refreshed update",
    );
    assert.equal(
      stopped.body.recording.replayResult.sourceFilterStats.valuesTransformed,
      1,
    );
    assert.equal(
      stopped.body.recording.replayResult.sourcePolicy.valueTransforms[0].path,
      "navigation.datetime",
    );
  } finally {
    plugin.stop();
  }
});

test("playback pacing remains live when the host wall clock moves backwards", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-monotonic-replay-"));
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
  const originalDateNow = Date.now;

  try {
    const captureName = "capture-2026-07-14T14-27-00-000Z.jsonl";
    const envelopes = [
      sensorEnvelope("2026-07-14T14:27:00.000Z", "YDEN.2"),
      sensorEnvelope("2026-07-14T14:27:00.200Z", "YDEN.2"),
      sensorEnvelope("2026-07-14T14:27:00.400Z", "YDEN.2"),
    ];
    await fs.writeFile(
      path.join(root, "captures", captureName),
      `${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await invokeOk(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "standard",
    });
    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      return status.playback.cursor === 1;
    });

    Date.now = () => originalDateNow() - 14 * 24 * 60 * 60 * 1000;
    const completed = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 1200);
      const poll = async () => {
        const status = await app.ajrmMarineLoggerApi.status();
        if (status.playback.lastReason === "end of capture") {
          clearTimeout(timeout);
          resolve(status);
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    assert.notEqual(
      completed,
      false,
      "a backwards wall-clock correction must not turn a sub-second replay gap into a multi-day timer",
    );
    assert.equal(completed.playback.cursor, 3);
    assert.equal(completed.playback.lastError, null);
  } finally {
    Date.now = originalDateNow;
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
    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });
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

test("recomputed replay abort stops injection and preserves an explicit incomplete partial manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-replay-abort-"));
  const app = fakeApp();
  app.ajrmMarineLoggerTestHooks = {
    calculationFlushQuietMs: 500,
    calculationFlushMaxMs: 1000,
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
    const captureName = "capture-2026-07-28T11-00-00-000Z.jsonl";
    const envelopes = [
      sensorEnvelope("2026-07-28T11:00:00.000Z", "YDEN.2"),
      sensorEnvelope("2026-07-28T11:00:01.000Z", "YDEN.2"),
    ];
    await fs.writeFile(
      path.join(root, "captures", captureName),
      `${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await invokeOk(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invokeOk(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-aborted-parent.zip",
    });
    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      return status.playback.cursor === 1;
    });

    const abortStartedAt = Date.now();
    const aborted = await invoke(
      routes,
      "POST",
      "/playback/result-capture/abort",
      { reason: "operator cancelled test replay" },
    );
    const abortElapsedMs = Date.now() - abortStartedAt;
    assert.equal(aborted.statusCode, 200);
    assert.ok(abortElapsedMs < 400, "abort must not wait for calculation quiet time");
    assert.equal(aborted.body.recording.active, false);
    const replayResult = aborted.body.recording.replayResult;
    assert.equal(replayResult.aborted, true);
    assert.equal(replayResult.incomplete, true);
    assert.equal(replayResult.abortReason, "operator cancelled test replay");
    assert.equal(replayResult.coverage.aborted, true);
    assert.equal(replayResult.coverage.abortReason, "operator cancelled test replay");
    assert.equal(replayResult.coverage.complete, false);
    assert.equal(replayResult.coverage.cursor, 1);
    assert.equal(replayResult.coverage.totalLines, 2);
    assert.equal(replayResult.resultSegments.aborted, true);
    assert.equal(replayResult.resultSegments.incomplete, true);
    assert.equal(replayResult.resultSegments.complete, false);
    assert.equal(replayResult.resultSegments.segmentsTotal, 1);
    assert.equal(replayResult.resultSegments.segmentsFinalized, 1);
    assert.equal(replayResult.resultSegments.segments[0].available, true);
    assert.equal(replayResult.resultSegments.segments[0].compressed, true);
    const preservedPath = path.join(
      root,
      "captures",
      replayResult.resultSegments.segments[0].fileName,
    );
    assert.ok((await fs.stat(preservedPath)).size > 0);
    const preservedBytes = await fs.readFile(preservedPath);
    assert.doesNotThrow(() => zlib.gunzipSync(preservedBytes));

    const status = await app.ajrmMarineLoggerApi.status();
    assert.equal(status.recording, null);
    assert.equal(status.playback.active, false);
    assert.equal(status.playback.lastReason, "operator cancelled test replay");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const laterStatus = await app.ajrmMarineLoggerApi.status();
    assert.equal(laterStatus.stats.playbackSent, 1);
  } finally {
    plugin.stop();
  }
});

test("recomputed playback failure remains explicit until the partial result is aborted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-replay-failure-"));
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
    const captureName = "capture-2026-07-28T11-30-00-000Z.jsonl";
    const capturePath = path.join(root, "captures", captureName);
    await fs.writeFile(
      capturePath,
      `${JSON.stringify(sensorEnvelope(
        "2026-07-28T11:30:00.000Z",
        "YDEN.2",
      ))}\n`,
    );
    await invokeOk(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      return status.playback.loaded === true;
    }, 5000);
    await invokeOk(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-failed-parent.zip",
    });
    await fs.unlink(capturePath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    const started = app.ajrmMarineLoggerApi.startPlayback(1);
    assert.equal(started.active, true);

    let failedStatus = null;
    await waitFor(async () => {
      failedStatus = await app.ajrmMarineLoggerApi.status();
      return Boolean(failedStatus.playback.lastError);
    });
    assert.equal(failedStatus.playback.active, false);
    assert.match(failedStatus.playback.lastError.message, /ENOENT|no such file/i);
    assert.equal(failedStatus.playback.lastError.fileName, captureName);
    assert.equal(failedStatus.playback.lastError.cursor, 0);
    assert.equal(failedStatus.playback.lastError.segmentCursor, 0);
    assert.equal(
      failedStatus.playback.lastError.originalCapturedAt,
      "2026-07-28T11:30:00.000Z",
    );
    assert.equal(failedStatus.recording.kind, "recomputed-replay");
    assert.equal(failedStatus.recording.replayResult.playbackFailed, true);
    assert.deepEqual(
      failedStatus.recording.replayResult.playbackError,
      failedStatus.playback.lastError,
    );
    assert.equal(failedStatus.recording.replayResult.coverage.complete, false);

    const rejectedResume = await invoke(routes, "POST", "/playback/play", {
      rate: 1,
    });
    assert.equal(rejectedResume.statusCode, 400);
    assert.match(rejectedResume.body.error, /failed and cannot resume/i);

    const aborted = await invoke(
      routes,
      "POST",
      "/playback/result-capture/abort",
      { reason: "aborted after playback read failure" },
    );
    assert.equal(aborted.statusCode, 200);
    assert.equal(aborted.body.recording.replayResult.aborted, true);
    assert.equal(aborted.body.recording.replayResult.incomplete, true);
    assert.equal(aborted.body.recording.replayResult.playbackFailed, true);
    assert.deepEqual(
      aborted.body.recording.replayResult.playbackError,
      failedStatus.playback.lastError,
    );
    const afterAbort = await app.ajrmMarineLoggerApi.status();
    assert.deepEqual(afterAbort.playback.lastError, failedStatus.playback.lastError);
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

    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });
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
    await invokeOk(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invokeOk(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-rotation-parent.zip",
    });
    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });
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
    await invokeOk(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invokeOk(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-rotation-parent.zip",
    });
    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });

    let activeManifest = null;
    await waitFor(async () => {
      const status = await app.ajrmMarineLoggerApi.status();
      activeManifest = status.recording?.replayResult?.resultSegments;
      return (
        status.playback.lastReason === "end of capture" &&
        activeManifest?.segmentsTotal === 3 &&
        activeManifest.segments.filter((segment) => segment.finalized).length >= 2
      );
    }, 5000, () => JSON.stringify(activeManifest));
    const firstSegment = activeManifest.segments[0];
    assert.equal(firstSegment.finalized, true);
    const rejectedDelete = await invoke(routes, "POST", "/files/delete", {
      kind: "logs",
      file: firstSegment.fileName,
    });
    assert.equal(rejectedDelete.statusCode, 400);
    assert.match(rejectedDelete.body.error, /finish or abort/i);
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

test("recomputed result manifest rejects a same-size unreadable gzip segment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ajrm-marine-logger-result-gzip-"));
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
    const captureName = "capture-2026-07-28T12-00-00-000Z.jsonl";
    const envelopes = [
      sensorEnvelope("2026-07-28T12:00:00.000Z", "YDEN.2"),
      sensorEnvelope("2026-07-28T12:00:00.050Z", "YDEN.2"),
      sensorEnvelope("2026-07-28T12:00:00.100Z", "YDEN.2"),
    ];
    await fs.writeFile(
      path.join(root, "captures", captureName),
      `${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await invokeOk(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invokeOk(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-corrupt-result-parent.zip",
    });
    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });

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
    assert.equal(firstSegment.compressed, true);
    const firstPath = path.join(root, "captures", firstSegment.fileName);
    const corrupted = await fs.readFile(firstPath);
    const changedIndex = Math.max(10, Math.floor((corrupted.length - 8) / 2));
    corrupted[changedIndex] ^= 0xff;
    await fs.writeFile(firstPath, corrupted);
    assert.equal((await fs.stat(firstPath)).size, firstSegment.bytes);
    assert.throws(() => zlib.gunzipSync(corrupted));

    const stopped = await invoke(routes, "POST", "/playback/result-capture/stop");
    assert.equal(stopped.statusCode, 200);
    const replayResult = stopped.body.recording.replayResult;
    assert.equal(replayResult.resultSegments.complete, false);
    assert.equal(replayResult.coverage.inputComplete, true);
    assert.equal(replayResult.coverage.resultSegmentsComplete, false);
    assert.equal(replayResult.coverage.complete, false);
    assert.equal(replayResult.resultSegments.segments[0].available, false);
    assert.match(
      replayResult.resultSegments.segments[0].error,
      /not readable gzip/i,
    );
    assert.equal(
      replayResult.resultSegments.errors.some((entry) =>
        entry.fileName === firstSegment.fileName &&
        /not readable gzip/i.test(entry.error),
      ),
      true,
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
    await invokeOk(routes, "POST", "/playback/load", {
      file: captureName,
      kind: "logs",
      mode: "sensor-sources",
      sensorSourceIds: ["YDEN.2"],
    });
    await invokeOk(routes, "POST", "/playback/result-capture/start", {
      parentVoyage: "voyage-flush-parent.zip",
    });
    await invokeOk(routes, "POST", "/playback/play", { rate: 1 });
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

async function invokeOk(routes, method, route, body = {}, query = {}) {
  const response = await invoke(routes, method, route, body, query);
  assert.equal(
    response.statusCode,
    200,
    `${method} ${route} failed: ${JSON.stringify(response.body)}`,
  );
  assert.equal(
    response.body?.ok,
    true,
    `${method} ${route} did not return ok: ${JSON.stringify(response.body)}`,
  );
  return response;
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
