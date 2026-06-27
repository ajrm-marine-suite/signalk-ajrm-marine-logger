const fs = require("node:fs");
const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const util = require("node:util");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const packageInfo = require("../package.json");
const { createPlaybackOperation } = require("./playback-operation");

const PLAYBACK_CLOCK_PATH = "plugins.ajrmMarineLogger.playback";
const POWER_INTENT_PATH = "plugins.ajrmMarinePiController.power.intent";
const RECORDING_METADATA_VERSION = 1;
const AJRM_MARINE_LOGGER_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineLoggerApi");
const execFile = util.promisify(childProcess.execFile);

module.exports = function ajrmMarineLogger(app) {
  const plugin = {};
  let options = normalizeOptions({});
  let paths = buildPaths(options.logDirectory);
  let deltaListener = null;
  let maintenanceTimer = null;
  let statusTimer = null;
  let currentBuffer = null;
  let recording = null;
  let shutdownPending = false;
  let lastPowerIntentKey = null;
  let playback = createPlaybackState();
  let runStartedAtMs = Date.now();
  const playbackOperation = createPlaybackOperation();
  const recordingMetadataCache = new Map();
  const recordingMetadataJobs = new Set();
  const recentEvents = [];
  const stats = {
    buffered: 0,
    captured: 0,
    filtered: 0,
    playbackSent: 0,
    parseErrors: 0,
    compressed: 0,
    compressionErrors: 0,
    autoAdvanced: 0,
  };

  plugin.id = "signalk-ajrm-marine-logger";
  plugin.name = "AJRM Marine Logger";
  plugin.description =
    "Rolling Signal K diagnostic capture, replay, and clip extraction.";

  plugin.schema = {
    type: "object",
    properties: {
      logDirectory: {
        type: "string",
        title: "Log directory",
        default: "~/CapturePlusLogs",
      },
      bufferMinutes: {
        type: "integer",
        title: "Rolling buffer duration in minutes",
        default: 30,
        minimum: 1,
        maximum: 1440,
      },
      segmentSeconds: {
        type: "integer",
        title: "Buffer segment duration in seconds",
        default: 60,
        minimum: 10,
        maximum: 3600,
      },
      maxBackfillMinutes: {
        type: "integer",
        title: "Maximum capture backfill in minutes",
        default: 120,
        minimum: 1,
        maximum: 1440,
      },
      captureSegmentMinutes: {
        type: "integer",
        title: "Capture file segment duration in minutes",
        default: 60,
        minimum: 1,
        maximum: 1440,
      },
      compressCompletedCaptures: {
        type: "boolean",
        title: "Gzip completed capture files",
        default: true,
      },
      autoAdvancePlayback: {
        type: "boolean",
        title: "Automatically play next recording segment",
        default: true,
      },
      autoStartCapture: {
        type: "boolean",
        title: "Automatically start capture when plugin starts",
        default: false,
      },
      includePaths: {
        type: "array",
        title: "Signal K paths to record",
        description:
          "Use * to record all paths. Entries may end with * for prefix matching, for example navigation.* or notifications.collision.*",
        default: ["*"],
        items: {
          type: "string",
        },
      },
      statusRefreshSeconds: {
        type: "integer",
        title: "Web status refresh interval",
        default: 2,
        minimum: 1,
        maximum: 60,
      },
    },
  };

  plugin.start = (pluginOptions = {}) => {
    runStartedAtMs = Date.now();
    shutdownPending = false;
    lastPowerIntentKey = null;
    options = normalizeOptions(pluginOptions);
    paths = buildPaths(options.logDirectory);
    ensureDirectories();
    options = { ...options, ...readSavedSettings() };
    clearStartupBufferFiles();
    rotateBuffer(new Date());
    pruneBuffer();
    recoverStaleCaptureFiles();
    deltaListener = (delta) => onLiveDelta(delta);
    app.signalk.on("delta", deltaListener);
    const api = {
      startCapture: ({ backfillMinutes } = {}) =>
        startRecording(clampInt(backfillMinutes, options.backfillMinutes, 0, options.maxBackfillMinutes)),
      stopCapture: (reason = "external stopped") => stopRecording(reason),
      status: () => buildStatus(),
      paths: () => ({ ...paths }),
    };
    app.ajrmMarineLoggerApi = api;
    globalThis[AJRM_MARINE_LOGGER_API_REGISTRY] = api;

    if (options.autoStartCapture) {
      startRecording(0).catch((error) => {
        logError("auto-start capture failed", error);
      });
    }

    maintenanceTimer = setInterval(() => {
      try {
        rotateBufferIfNeeded(new Date());
        pruneBuffer();
      } catch (error) {
        logError("maintenance failed", error);
      }
    }, 5000);

    statusTimer = setInterval(updateProviderStatus, 10000);
    updateProviderStatus();
    addEvent("started", `AJRM Marine Logger v${packageInfo.version} started`);
  };

  plugin.stop = () => {
    if (deltaListener) {
      app.signalk.removeListener("delta", deltaListener);
      deltaListener = null;
    }
    clearInterval(maintenanceTimer);
    clearInterval(statusTimer);
    maintenanceTimer = null;
    statusTimer = null;
    stopPlayback("plugin stopped");
    stopRecording("plugin stopped");
    closeBuffer();
    if (app.ajrmMarineLoggerApi?.paths) delete app.ajrmMarineLoggerApi;
    if (globalThis[AJRM_MARINE_LOGGER_API_REGISTRY]?.paths) {
      delete globalThis[AJRM_MARINE_LOGGER_API_REGISTRY];
    }
  };

  plugin.registerWithRouter = function registerWithRouter(router) {
    registerRoutes(router);
  };

  plugin.signalKApiRoutes = function signalKApiRoutes(router) {
    registerRoutes(router, {
      prefix: "/ajrmMarineLogger",
      requireWriteAccess: true,
    });
    return router;
  };

  return plugin;

  function registerRoutes(router, routeOptions = {}) {
    const prefix = routeOptions.prefix || "";
    const write = routeOptions.requireWriteAccess ? requireWriteAccess : (handler) => handler;

    router.get(`${prefix}/status`, async (_req, res) => {
      try {
        res.json(await buildStatus());
      } catch (error) {
        logError("status failed", error);
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.get(`${prefix}/captures`, async (_req, res) => {
      try {
        res.json({
          ok: true,
          captures: await listCaptures(),
          clips: await listClips(),
          voyages: await listVoyages(),
        });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    router.post(`${prefix}/capture/start`, write(async (req, res) => {
      try {
        if (playback.active) {
          res.status(409).json({ ok: false, error: "Stop playback before recording" });
          return;
        }
        const backfillMinutes = clampInt(
          req.body?.backfillMinutes,
          options.backfillMinutes,
          0,
          options.maxBackfillMinutes,
        );
        const result = await startRecording(backfillMinutes);
        res.json({ ok: true, recording: result });
      } catch (error) {
        logError("start capture failed", error);
        res.status(500).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/capture/stop`, write(async (_req, res) => {
      try {
        res.json({ ok: true, recording: stopRecording("user stopped") });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/load`, write(async (req, res) => {
      try {
        if (recording) {
          res.status(409).json({ ok: false, error: "Stop recording before playback" });
          return;
        }
        const fileName = safeBaseName(req.body?.file);
        const result = await loadPlayback(fileName, req.body?.kind);
        res.json({ ok: true, playback: result });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/play`, write(async (req, res) => {
      try {
        const rate = normalizePlaybackRate(req.body?.rate, playback.rate || 1);
        startPlayback(rate);
        res.json({ ok: true, playback: getPlaybackSummary() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/rate`, write(async (req, res) => {
      try {
        const rate = normalizePlaybackRate(req.body?.rate, playback.rate || 1);
        setPlaybackRate(rate);
        res.json({ ok: true, playback: getPlaybackSummary() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/pause`, write((_req, res) => {
      pausePlayback("paused");
      res.json({ ok: true, playback: getPlaybackSummary() });
    }));

    router.post(`${prefix}/playback/stop`, write((_req, res) => {
      stopPlayback("stopped");
      res.json({ ok: true, playback: getPlaybackSummary() });
    }));

    router.post(`${prefix}/playback/seek`, write(async (req, res) => {
      try {
        const target = req.body?.capturedAt || req.body?.offsetSeconds;
        await seekPlayback(target);
        res.json({ ok: true, playback: getPlaybackSummary() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/settings`, write((req, res) => {
      try {
        if (typeof req.body?.autoAdvancePlayback === "boolean") {
          options.autoAdvancePlayback = req.body.autoAdvancePlayback;
          addEvent(
            "settings",
            `Playback auto-advance ${options.autoAdvancePlayback ? "enabled" : "disabled"}`,
          );
        }
        if (typeof req.body?.autoStartCapture === "boolean") {
          options.autoStartCapture = req.body.autoStartCapture;
          addEvent(
            "settings",
            `Capture auto-start ${options.autoStartCapture ? "enabled" : "disabled"}`,
          );
        }
        if (req.body?.backfillMinutes !== undefined) {
          options.backfillMinutes = clampInt(
            req.body.backfillMinutes,
            options.backfillMinutes,
            0,
            options.maxBackfillMinutes,
          );
          addEvent("settings", `Pre-capture time set to ${options.backfillMinutes} minutes`);
        }
        if (req.body?.captureSegmentMinutes !== undefined) {
          options.captureSegmentMinutes = clampInt(
            req.body.captureSegmentMinutes,
            options.captureSegmentMinutes,
            1,
            1440,
          );
          addEvent("settings", `Log cycle set to ${options.captureSegmentMinutes} minutes`);
        }
        saveRuntimeSettings();
        res.json({ ok: true, options, playback: getPlaybackSummary() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.get(`${prefix}/files/:kind/:file/download`, async (req, res) => {
      try {
        const kind = normalizeRecordingKind(req.params.kind);
        const fileName = safeBaseName(req.params.file);
        const filePath = path.join(recordingDirectoryForKind(kind), fileName);
        const statsInfo = await fs.promises.stat(filePath).catch(() => null);
        if (!statsInfo?.isFile()) {
          res.status(404).json({ ok: false, error: `File not found: ${fileName}` });
          return;
        }
        res.download(filePath, fileName);
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    });

    router.post(`${prefix}/files/delete`, write(async (req, res) => {
      try {
        const result = await deleteRecordingFile({
          kind: req.body?.kind,
          fileName: safeBaseName(req.body?.file),
        });
        res.json({ ok: true, deleted: result });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/clips/extract`, write(async (req, res) => {
      try {
        const requestedFile = req.body?.file ? safeBaseName(req.body.file) : "";
        const result = await extractClip({
          fileName: requestedFile,
          kind: "logs",
          from: req.body?.from,
          to: req.body?.to,
          label: req.body?.label,
          clipName: req.body?.clipName,
        });
        res.json({ ok: true, clip: result });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));
  }

  function requireWriteAccess(handler) {
    return function writeAccessHandler(req, res) {
      const permission = req.skPrincipal?.permissions;
      if (
        permission === "admin" ||
        permission === "readwrite" ||
        (permission === undefined && req.skIsAuthenticated !== false)
      ) {
        return handler(req, res);
      }
      res.status(403).json({
        ok: false,
        error:
          "CapturePlus control requires Signal K read/write or admin access. Approve this device in Access Requests/Devices, or log in as an admin.",
      });
      return undefined;
    };
  }

  function normalizeOptions(value) {
    return {
      logDirectory: expandHome(String(value.logDirectory || "~/CapturePlusLogs")),
      bufferMinutes: clampInt(value.bufferMinutes, 30, 1, 1440),
      segmentSeconds: clampInt(value.segmentSeconds, 60, 10, 3600),
      maxBackfillMinutes: clampInt(value.maxBackfillMinutes, 120, 1, 1440),
      backfillMinutes: clampInt(value.backfillMinutes, 30, 0, 1440),
      captureSegmentMinutes: clampInt(value.captureSegmentMinutes, 60, 1, 1440),
      compressCompletedCaptures: value.compressCompletedCaptures !== false,
      autoAdvancePlayback: value.autoAdvancePlayback !== false,
      autoStartCapture: value.autoStartCapture === true,
      includePaths: normalizeIncludePaths(value.includePaths),
      statusRefreshSeconds: clampInt(value.statusRefreshSeconds, 2, 1, 60),
    };
  }

  function normalizeIncludePaths(value) {
    const entries = Array.isArray(value) ? value : ["*"];
    const clean = entries.map((entry) => String(entry || "").trim()).filter(Boolean);
    return clean.length ? clean : ["*"];
  }

  function buildPaths(root) {
    return {
      root,
      buffer: path.join(root, "buffer"),
      captures: path.join(root, "captures"),
      clips: path.join(root, "clips"),
      voyages: path.join(root, "voyages"),
      voyageReplay: path.join(root, "voyage-replay-cache"),
      settings: path.join(root, "settings.json"),
    };
  }

  function ensureDirectories() {
    for (const directory of [
      paths.root,
      paths.buffer,
      paths.captures,
      paths.clips,
      paths.voyages,
      paths.voyageReplay,
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  function readSavedSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.settings, "utf8"));
      return {
        autoAdvancePlayback: parsed.autoAdvancePlayback !== false,
        autoStartCapture: parsed.autoStartCapture === true,
        backfillMinutes: clampInt(parsed.backfillMinutes, 30, 0, 1440),
        captureSegmentMinutes: clampInt(parsed.captureSegmentMinutes, 60, 1, 1440),
      };
    } catch {
      return {};
    }
  }

  function saveRuntimeSettings() {
    fs.writeFileSync(
      paths.settings,
      `${JSON.stringify({
        autoAdvancePlayback: options.autoAdvancePlayback,
        autoStartCapture: options.autoStartCapture,
        backfillMinutes: options.backfillMinutes,
        captureSegmentMinutes: options.captureSegmentMinutes,
      }, null, 2)}\n`,
    );
  }

  function onLiveDelta(delta) {
    if (!delta || typeof delta !== "object") return;
    if (delta.$source === plugin.id || delta.source?.label === plugin.id) return;
    if (handlePowerIntent(delta)) return;
    if (shutdownPending) return;
    if (playback.active || playback.paused) return;
    if (isPlaybackClockDelta(delta)) return;

    const filtered = filterDelta(delta);
    if (!filtered) {
      stats.filtered += 1;
      return;
    }

    const capturedAt = getDeltaTimestamp(filtered) || new Date().toISOString();
    const envelope = { capturedAt, delta: filtered };
    writeBufferEnvelope(envelope);
    if (recording && !playback.active) {
      writeRecordingEnvelope(envelope);
    }
  }

  function handlePowerIntent(delta) {
    let handled = false;
    for (const update of delta.updates || []) {
      for (const entry of update.values || []) {
        if (entry.path !== POWER_INTENT_PATH) continue;
        const intent = unwrapValue(entry.value);
        if (!intent || typeof intent !== "object") continue;
        if (!["shutdown", "reboot"].includes(intent.action)) continue;
        if (!["waiting", "running"].includes(intent.status)) continue;
        const key = `${intent.action}:${intent.requestedAt || intent.runAt || ""}:${intent.status}`;
        if (key === lastPowerIntentKey) {
          handled = true;
          continue;
        }
        lastPowerIntentKey = key;
        shutdownPending = true;
        const summary = stopRecording(`AJRM Marine Pi Controller ${intent.action} requested`);
        closeBuffer();
        addEvent(
          "power-intent",
          `${intent.action} ${intent.status}; ${summary?.fileName || "no active capture"} closed`,
        );
        logInfo(
          `AJRM Marine Pi Controller ${intent.action} ${intent.status}; ${summary?.fileName || "no active capture"} closed`,
        );
        updateProviderStatus();
        handled = true;
      }
    }
    return handled;
  }

  function isPlaybackClockDelta(delta) {
    return (delta.updates || []).some((update) =>
      (update.values || []).some((entry) => entry.path === PLAYBACK_CLOCK_PATH),
    );
  }

  function filterDelta(delta) {
    if (options.includePaths.includes("*")) return delta;
    if (!Array.isArray(delta.updates)) return null;

    const updates = delta.updates
      .map((update) => {
        const values = Array.isArray(update.values)
          ? update.values.filter((entry) => pathIncluded(entry.path))
          : [];
        if (!values.length) return null;
        return { ...update, values };
      })
      .filter(Boolean);

    if (!updates.length) return null;
    return { ...delta, updates };
  }

  function pathIncluded(signalKPath) {
    const value = String(signalKPath || "");
    return options.includePaths.some((pattern) => {
      if (pattern === "*") return true;
      if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
      return value === pattern;
    });
  }

  function writeBufferEnvelope(envelope) {
    try {
      rotateBufferIfNeeded(new Date());
      currentBuffer.stream.write(`${JSON.stringify(envelope)}\n`);
      currentBuffer.lines += 1;
      stats.buffered += 1;
    } catch (error) {
      logError("buffer write failed", error);
    }
  }

  function writeRecordingEnvelope(envelope) {
    if (!recording) return;
    try {
      if (recording.backfilling) {
        recording.pendingEnvelopes.push(envelope);
        return;
      }
      rotateRecordingIfNeeded(new Date());
      appendRecordingEnvelope(recording, envelope);
    } catch (error) {
      logError("capture write failed", error);
    }
  }

  function appendRecordingEnvelope(segment, envelope) {
    segment.stream.write(`${JSON.stringify(envelope)}\n`);
    segment.lines += 1;
    updateRecordingRange(segment, envelope.capturedAt);
    stats.captured += 1;
  }

  function updateRecordingRange(segment, capturedAt) {
    const ts = Date.parse(capturedAt);
    if (!Number.isFinite(ts)) return;
    const fromMs = Date.parse(segment.from);
    const toMs = Date.parse(segment.to);
    if (!Number.isFinite(fromMs) || ts < fromMs) segment.from = capturedAt;
    if (!Number.isFinite(toMs) || ts > toMs) segment.to = capturedAt;
  }

  async function startRecording(backfillMinutes) {
    if (recording) return getRecordingSummary();
    ensureDirectories();
    const startedAt = new Date();
    const fileName = `capture-${formatFileTime(startedAt)}.jsonl`;
    const filePath = path.join(paths.captures, fileName);
    const stream = fs.createWriteStream(filePath, { flags: "a" });
    recording = {
      fileName,
      filePath,
      startedAt: startedAt.toISOString(),
      startedAtMs: startedAt.getTime(),
      backfillMinutes,
      lines: 0,
      backfilled: 0,
      from: null,
      to: null,
      stream,
      backfilling: true,
      pendingEnvelopes: [],
    };

    const cutoffMs = startedAt.getTime() - backfillMinutes * 60 * 1000;
    recording.backfilled = await copyBufferToStream(stream, cutoffMs, recording);
    const pendingEnvelopes = recording.pendingEnvelopes;
    recording.backfilling = false;
    recording.pendingEnvelopes = [];
    for (const envelope of pendingEnvelopes) {
      rotateRecordingIfNeeded(new Date());
      appendRecordingEnvelope(recording, envelope);
    }
    addEvent("capture-started", `Started ${fileName} with ${recording.backfilled} buffered deltas`);
    updateProviderStatus();
    return getRecordingSummary();
  }

  function stopRecording(reason) {
    if (!recording) return null;
    const summary = getRecordingSummary();
    finishRecordingStream(recording, true);
    addEvent("capture-stopped", `${summary.fileName} stopped: ${reason}`);
    recording = null;
    updateProviderStatus();
    return summary;
  }

  function rotateRecordingIfNeeded(now) {
    if (!recording) return;
    const elapsedMs = now.getTime() - recording.startedAtMs;
    if (elapsedMs < options.captureSegmentMinutes * 60 * 1000) return;

    const previous = recording;
    finishRecordingStream(previous, true);

    const fileName = `capture-${formatFileTime(now)}.jsonl`;
    const filePath = path.join(paths.captures, fileName);
    recording = {
      fileName,
      filePath,
      startedAt: now.toISOString(),
      startedAtMs: now.getTime(),
      backfillMinutes: 0,
      lines: 0,
      backfilled: 0,
      from: null,
      to: null,
      stream: fs.createWriteStream(filePath, { flags: "a" }),
      backfilling: false,
      pendingEnvelopes: [],
    };
    addEvent("capture-rotated", `${previous.fileName} closed; ${fileName} started`);
    updateProviderStatus();
  }

  function finishRecordingStream(segment, shouldCompress) {
    const filePath = segment?.filePath;
    const stream = segment?.stream;
    if (!filePath || !stream) return;
    stream.end(() => {
      if (shouldCompress && options.compressCompletedCaptures) {
        compressRecordingFile(filePath)
          .then((compressedPath) => {
            if (compressedPath) queueRecordingMetadata(compressedPath, "capture-closed");
            else queueRecordingMetadata(filePath, "capture-closed");
          })
          .catch((error) => {
            logError("capture compression failed", error);
          });
      } else {
        queueRecordingMetadata(filePath, "capture-closed");
      }
    });
  }

  async function compressRecordingFile(filePath) {
    if (!filePath.endsWith(".jsonl")) return null;
    const compressedPath = `${filePath}.gz`;
    const statsInfo = await fs.promises.stat(filePath).catch(() => null);
    if (!statsInfo?.isFile() || statsInfo.size === 0) return null;
    if (await fileExists(compressedPath)) {
      await fs.promises.unlink(filePath).catch(() => {});
      await fs.promises.unlink(recordingMetadataPath(filePath)).catch(() => {});
      return compressedPath;
    }

    const tempPath = `${compressedPath}.tmp`;
    try {
      await pipeline(
        fs.createReadStream(filePath),
        zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED }),
        fs.createWriteStream(tempPath, { flags: "w" }),
      );
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw error;
    }
    await fs.promises.rename(tempPath, compressedPath);
    await fs.promises.unlink(filePath).catch(() => {});
    await fs.promises.unlink(recordingMetadataPath(filePath)).catch(() => {});
    stats.compressed += 1;
    addEvent("capture-compressed", `${path.basename(filePath)} compressed`);
    return compressedPath;
  }

  function recoverStaleCaptureFiles() {
    Promise.all([
      removeOrphanCompressionTemps(paths.captures),
      removeOrphanMetadataTemps(paths.captures),
      removeOrphanMetadataTemps(paths.clips),
      removeEmptyStaleCaptureFiles(paths.captures),
    ])
      .then(() => {
        if (options.compressCompletedCaptures) return compressStaleCaptureFiles();
        return null;
      })
      .catch((error) => logError("startup capture recovery failed", error));
  }

  async function removeOrphanCompressionTemps(directory) {
    const names = await fs.promises.readdir(directory).catch(() => []);
    const tempNames = names.filter((name) => name.endsWith(".jsonl.gz.tmp"));
    await Promise.all(
      tempNames.map((name) => fs.promises.unlink(path.join(directory, name)).catch(() => null)),
    );
    if (tempNames.length) {
      addEvent("startup-cleanup", `Removed ${tempNames.length} incomplete capture compression file${tempNames.length === 1 ? "" : "s"}`);
    }
  }

  async function removeOrphanMetadataTemps(directory) {
    const names = await fs.promises.readdir(directory).catch(() => []);
    const tempNames = names.filter((name) => name.endsWith(".meta.json.tmp"));
    await Promise.all(
      tempNames.map((name) => fs.promises.unlink(path.join(directory, name)).catch(() => null)),
    );
    if (tempNames.length) {
      addEvent("startup-cleanup", `Removed ${tempNames.length} incomplete metadata file${tempNames.length === 1 ? "" : "s"}`);
    }
  }

  async function removeEmptyStaleCaptureFiles(directory) {
    const files = await listJsonlFiles(directory);
    const emptyFiles = files.filter((file) => file.name !== recording?.fileName && file.size === 0);
    await Promise.all(
      emptyFiles.map(async (file) => {
        const filePath = path.join(directory, file.name);
        await fs.promises.unlink(filePath).catch(() => null);
        await fs.promises.unlink(recordingMetadataPath(filePath)).catch(() => null);
      }),
    );
    if (emptyFiles.length) {
      addEvent("startup-cleanup", `Removed ${emptyFiles.length} empty stale capture log${emptyFiles.length === 1 ? "" : "s"}`);
    }
  }

  async function compressStaleCaptureFiles() {
    const files = await listJsonlFiles(paths.captures);
    const results = await Promise.all(
      files
        .filter((file) => file.name !== recording?.fileName && file.size > 0)
        .map((file) => compressRecordingFile(path.join(paths.captures, file.name))),
    );
    const compressed = results.filter(Boolean).length;
    if (compressed) addEvent("startup-compression", `Compressed ${compressed} stale captures`);
    for (const compressedPath of results.filter(Boolean)) {
      queueRecordingMetadata(compressedPath, "startup-compression");
    }
  }

  async function copyBufferToStream(stream, cutoffMs, capture) {
    let copied = 0;
    const files = await listJsonlFiles(paths.buffer);
    for (const file of files) {
      if (file.mtimeMs < runStartedAtMs && file.name !== currentBuffer?.fileName) continue;
      await readEnvelopes(path.join(paths.buffer, file.name), async (envelope) => {
        const ts = Date.parse(envelope.capturedAt);
        if (!Number.isFinite(ts) || ts < cutoffMs || ts < runStartedAtMs) return;
        stream.write(`${JSON.stringify(envelope)}\n`);
        copied += 1;
        capture.lines += 1;
        updateRecordingRange(capture, envelope.capturedAt);
      });
    }
    return copied;
  }

  function rotateBufferIfNeeded(now) {
    if (!currentBuffer) {
      rotateBuffer(now);
      return;
    }
    const elapsed = now.getTime() - currentBuffer.startedAtMs;
    if (elapsed >= options.segmentSeconds * 1000) rotateBuffer(now);
  }

  function rotateBuffer(now) {
    closeBuffer();
    const fileName = `buffer-${formatFileTime(now)}.jsonl`;
    currentBuffer = {
      fileName,
      filePath: path.join(paths.buffer, fileName),
      startedAtMs: now.getTime(),
      startedAt: now.toISOString(),
      lines: 0,
      stream: fs.createWriteStream(path.join(paths.buffer, fileName), { flags: "a" }),
    };
  }

  function closeBuffer() {
    if (currentBuffer?.stream) currentBuffer.stream.end();
    currentBuffer = null;
  }

  async function pruneBuffer() {
    const cutoffMs = Date.now() - options.bufferMinutes * 60 * 1000 - options.segmentSeconds * 1000;
    const files = await listJsonlFiles(paths.buffer);
    for (const file of files) {
      if (file.mtimeMs < cutoffMs && file.name !== currentBuffer?.fileName) {
        await fs.promises.unlink(path.join(paths.buffer, file.name)).catch(() => {});
      }
    }
  }

  function clearStartupBufferFiles() {
    let names = [];
    try {
      names = fs.readdirSync(paths.buffer, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        fs.unlinkSync(path.join(paths.buffer, entry.name));
      } catch {
        // Best effort: unreadable stale buffers are also excluded by runStartedAtMs.
      }
    }
  }

  async function loadPlayback(fileName, kind) {
    stopPlayback("loading");
    const normalizedKind = kind ? normalizeRecordingKind(kind) : null;
    if (normalizedKind === "voyages") {
      const firstSegment = await prepareVoyagePlayback(fileName);
      return loadPlaybackFile({
        fileName: firstSegment.name,
        filePath: firstSegment.fullPath,
        sourceDirectory: firstSegment.directory,
        sourceKind: "voyages",
        voyageFileName: fileName,
        displayFileName: `${fileName} / ${firstSegment.name}`,
      });
    }
    const filePath = await resolveCaptureOrClip(fileName, normalizedKind);
    return loadPlaybackFile({
      fileName,
      filePath,
      sourceDirectory: path.dirname(filePath),
      sourceKind: normalizedKind || recordingKindForPath(filePath),
      displayFileName: fileName,
    });
  }

  async function loadPlaybackFile({
    fileName,
    filePath,
    sourceDirectory,
    sourceKind,
    voyageFileName,
    displayFileName,
  }) {
    const statsInfo = await fs.promises.stat(filePath).catch(() => null);
    const metadata = await scanFile(filePath, Infinity, true);
    if (statsInfo?.isFile()) {
      await writeRecordingMetadataFile(filePath, statsInfo, metadata);
    }
    playback = {
      ...createPlaybackState(),
      fileName,
      filePath,
      sourceDirectory,
      sourceKind,
      voyageFileName: voyageFileName || null,
      displayFileName: displayFileName || fileName,
      loaded: true,
      totalLines: metadata.lines,
      from: metadata.from,
      to: metadata.to,
      current: metadata.from,
      cursor: 0,
      offsets: metadata.offsets,
      times: metadata.times,
    };
    addEvent("playback-loaded", `Loaded ${playback.displayFileName}`);
    return getPlaybackSummary();
  }

  async function prepareVoyagePlayback(fileName) {
    if (!/\.zip$/i.test(fileName)) {
      throw new Error("Voyage playback currently supports .zip voyage bundles");
    }
    ensureDirectories();
    const sourcePath = path.join(paths.voyages, fileName);
    const statsInfo = await fs.promises.stat(sourcePath).catch(() => null);
    if (!statsInfo?.isFile()) throw new Error(`Voyage not found: ${fileName}`);
    await assertSafeZipEntries(sourcePath, fileName);

    const replayDirectory = path.join(paths.voyageReplay, safeReplayDirectoryName(fileName));
    await fs.promises.rm(replayDirectory, { recursive: true, force: true });
    await fs.promises.mkdir(replayDirectory, { recursive: true });
    try {
      await execFile("unzip", ["-q", "-o", sourcePath, "-d", replayDirectory], {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`Unable to extract voyage ${fileName}: ${error.message || error}`);
    }

    const captureDirectory = path.join(replayDirectory, "capture");
    const directory = (await directoryExists(captureDirectory)) ? captureDirectory : replayDirectory;
    let segments = await listRecordingFiles(directory);
    if (!segments.length) {
      await linkReferencedVoyageSegments(sourcePath, fileName, directory);
    }
    await materializeCompressedReplaySegments(directory);
    segments = await listRecordingFiles(directory);
    if (!segments.length) {
      throw new Error(`Voyage ${fileName} does not contain any CapturePlus recording segments`);
    }
    const first = segments[0];
    return {
      name: first.name,
      fullPath: path.join(directory, first.name),
      directory,
    };
  }

  async function linkReferencedVoyageSegments(sourcePath, voyageFileName, directory) {
    const index = await readVoyageZipIndex(sourcePath);
    const references = Array.isArray(index?.captureReferences)
      ? index.captureReferences
      : [];
    if (!references.length) return 0;
    await fs.promises.mkdir(directory, { recursive: true });
    let linked = 0;
    const missing = [];
    for (const reference of references) {
      const sourceFile = await resolveReferencedCaptureFile(reference);
      if (!sourceFile) {
        missing.push(reference?.fileName || reference?.compressedSourcePath || "unknown");
        continue;
      }
      const linkName = path.basename(sourceFile);
      const linkPath = path.join(directory, linkName);
      await fs.promises.rm(linkPath, { force: true }).catch(() => {});
      try {
        await fs.promises.symlink(sourceFile, linkPath);
      } catch (_error) {
        await fs.promises.copyFile(sourceFile, linkPath);
      }
      linked += 1;
    }
    if (!linked && missing.length) {
      throw new Error(
        `Voyage ${voyageFileName} references local capture files that are not available: ${missing.join(", ")}`,
      );
    }
    return linked;
  }

  async function materializeCompressedReplaySegments(directory) {
    const segments = await listRecordingFiles(directory);
    for (const segment of segments) {
      if (!segment.name.endsWith(".jsonl.gz")) continue;
      const compressedPath = path.join(directory, segment.name);
      const plainName = segment.name.replace(/\.gz$/i, "");
      const plainPath = path.join(directory, plainName);
      const existing = await fs.promises.stat(plainPath).catch(() => null);
      if (existing?.isFile() && existing.size > 0) continue;
      const temporaryPath = `${plainPath}.${process.pid}.${Date.now()}.tmp`;
      await pipeline(
        fs.createReadStream(compressedPath),
        zlib.createGunzip(),
        fs.createWriteStream(temporaryPath),
      );
      await fs.promises.rename(temporaryPath, plainPath);
    }
  }

  async function resolveReferencedCaptureFile(reference = {}) {
    const names = new Set();
    for (const value of [
      reference.compressedSourcePath,
      reference.sourcePath,
      reference.fileName,
    ]) {
      const name = path.basename(String(value || ""));
      if (!name || name === "." || name === path.sep) continue;
      names.add(name);
      if (name.endsWith(".jsonl")) names.add(`${name}.gz`);
    }
    for (const name of names) {
      if (!/\.jsonl(?:\.gz)?$/i.test(name)) continue;
      const candidate = path.join(paths.captures, name);
      const statsInfo = await fs.promises.stat(candidate).catch(() => null);
      if (statsInfo?.isFile()) return candidate;
    }
    return null;
  }

  function startPlayback(rate) {
    if (!playback.loaded) throw new Error("Load a capture before playback");
    playback.rate = rate;
    playback.active = true;
    playback.paused = false;
    playback.lastReason = "playing";
    playback.sourceAnchorMs = null;
    playback.wallAnchorMs = null;
    playback.lastLineWallMs = null;
    const generation = playbackOperation.begin();
    scheduleNextPlaybackLine(0, generation);
    addEvent("playback-started", `${playback.fileName} at ${rate}x`);
    updateProviderStatus();
  }

  function setPlaybackRate(rate) {
    if (!playback.loaded) throw new Error("Load a capture before setting playback speed");
    const oldRate = playback.rate;
    playback.rate = rate;
    playback.lastReason = playback.active ? "playing" : playback.lastReason;
    publishPlaybackClock(playback.active || playback.paused);
    if (playback.active && !playback.paused) {
      reschedulePlaybackForRateChange();
    }
    addEvent("playback-rate", `${playback.fileName || "Playback"} speed ${oldRate}x -> ${rate}x`);
    updateProviderStatus();
  }

  function pausePlayback(reason) {
    if (!playback.loaded) return;
    playback.paused = true;
    playback.active = false;
    playback.lastReason = reason;
    playbackOperation.invalidate();
    clearTimeout(playback.timer);
    playback.timer = null;
    publishPlaybackClock(true);
    updateProviderStatus();
  }

  function stopPlayback(reason) {
    if (!playback.loaded && !playback.active) return;
    clearTimeout(playback.timer);
    playback.timer = null;
    playback.active = false;
    playback.paused = false;
    playback.cursor = 0;
    playback.current = playback.from;
    playback.previousTs = null;
    playback.lastLineWallMs = null;
    playback.lastReason = reason;
    playbackOperation.invalidate();
    publishPlaybackClock(false);
    updateProviderStatus();
  }

  async function seekPlayback(target) {
    if (!playback.loaded) throw new Error("Load a capture before seeking");
    const targetMs = parseSeekTarget(target);
    const position = findLineAtOrAfter(targetMs);
    playback.cursor = position.lineIndex;
    playback.current = position.capturedAt || playback.from;
    playback.previousTs = null;
    playback.lastLineWallMs = null;
    playback.paused = true;
    playback.active = false;
    playbackOperation.invalidate();
    clearTimeout(playback.timer);
    playback.timer = null;
    publishPlaybackClock(playback.active);
    addEvent("playback-seek", `Seeked to ${playback.current}`);
  }

  function scheduleNextPlaybackLine(
    delayMs,
    generation = playbackOperation.current(),
  ) {
    clearTimeout(playback.timer);
    playback.timer = setTimeout(() => {
      sendNextPlaybackLine(generation).catch((error) => {
        if (!playbackOperation.isCurrent(generation)) return;
        logError("playback failed", error);
        pausePlayback(error.message);
      });
    }, Math.max(0, delayMs));
  }

  function reschedulePlaybackForRateChange() {
    const currentMs = playback.previousTs;
    const nextMs = playback.times?.[playback.cursor];
    const lastWallMs = playback.lastLineWallMs;
    if (
      !Number.isFinite(currentMs) ||
      !Number.isFinite(nextMs) ||
      !Number.isFinite(lastWallMs)
    ) {
      scheduleNextPlaybackLine(0);
      return;
    }
    playback.sourceAnchorMs = currentMs;
    playback.wallAnchorMs = Date.now();
    scheduleNextPlaybackLine(playbackDelayToTimestamp(nextMs));
  }

  async function sendNextPlaybackLine(generation) {
    const batchStartedMs = Date.now();
    let nextDelayMs = 0;
    while (true) {
      if (
        !playbackOperation.isCurrent(generation) ||
        !playback.active ||
        playback.paused
      ) {
        return;
      }
      const entry = await readEnvelopeAtLine(playback.filePath, playback.cursor);
      if (
        !playbackOperation.isCurrent(generation) ||
        !playback.active ||
        playback.paused
      ) {
        return;
      }
      if (!entry) {
        if (await autoAdvancePlaybackSegment()) return;
        pausePlayback("end of capture");
        return;
      }

      playback.cursor += 1;
      playback.current = entry.capturedAt;
      publishPlaybackClock(true);
      const replayDelta = replayDeltaAsLiveInputs(entry.delta);
      if (replayDelta) {
        app.handleMessage(plugin.id, replayDelta);
      }
      stats.playbackSent += 1;

      const currentMs = Date.parse(entry.capturedAt);
      playback.lastLineWallMs = Date.now();
      if (Number.isFinite(currentMs)) {
        playback.previousTs = currentMs;
        if (
          !Number.isFinite(playback.sourceAnchorMs) ||
          !Number.isFinite(playback.wallAnchorMs)
        ) {
          playback.sourceAnchorMs = currentMs;
          playback.wallAnchorMs = playback.lastLineWallMs;
        }
      }
      nextDelayMs = playbackDelayToTimestamp(playback.times?.[playback.cursor]);
      if (nextDelayMs > 0 || Date.now() - batchStartedMs >= 40) break;
    }
    scheduleNextPlaybackLine(nextDelayMs, generation);
  }

  function playbackDelayToTimestamp(nextSourceMs) {
    if (playback.rate === "max") return 0;
    return calculatePlaybackDelayMs({
      nextSourceMs,
      sourceAnchorMs: playback.sourceAnchorMs,
      wallAnchorMs: playback.wallAnchorMs,
      rate: playback.rate,
      nowMs: Date.now(),
    });
  }

  async function autoAdvancePlaybackSegment() {
    if (!options.autoAdvancePlayback || !playback.sourceDirectory || recording) return false;
    const nextFile = await nextRecordingFileAfter(playback.sourceDirectory, playback);
    if (!nextFile) return false;

    const rate = playback.rate || 1;
    await loadPlaybackFile({
      fileName: nextFile.name,
      filePath: path.join(playback.sourceDirectory, nextFile.name),
      sourceDirectory: playback.sourceDirectory,
      sourceKind: playback.sourceKind,
      voyageFileName: playback.voyageFileName,
      displayFileName: playback.voyageFileName
        ? `${playback.voyageFileName} / ${nextFile.name}`
        : nextFile.name,
    });
    playback.rate = rate;
    playback.active = true;
    playback.paused = false;
    playback.lastReason = "playing next segment";
    playback.sourceAnchorMs = null;
    playback.wallAnchorMs = null;
    playback.lastLineWallMs = null;
    const generation = playbackOperation.begin();
    stats.autoAdvanced += 1;
    addEvent("playback-next", `Continuing with ${nextFile.name}`);
    publishPlaybackClock(true);
    scheduleNextPlaybackLine(0, generation);
    updateProviderStatus();
    return true;
  }

  async function deleteRecordingFile({ kind, fileName }) {
    const directory = recordingDirectoryForKind(kind);
    if (recording?.fileName === fileName) {
      throw new Error("Stop capture before deleting the active log file");
    }
    if (playback.loaded && playback.fileName === fileName) {
      throw new Error("Stop playback or load another file before deleting this file");
    }
    const filePath = path.join(directory, fileName);
    const statsInfo = await fs.promises.stat(filePath).catch(() => null);
    if (!statsInfo?.isFile()) throw new Error(`File not found: ${fileName}`);
    await fs.promises.unlink(filePath);
    await fs.promises.unlink(recordingMetadataPath(filePath)).catch(() => {});
    addEvent("file-deleted", `Deleted ${fileName}`);
    return { kind: normalizeRecordingKind(kind), fileName };
  }

  function recordingDirectoryForKind(kind) {
    const normalized = normalizeRecordingKind(kind);
    if (normalized === "clips") return paths.clips;
    if (normalized === "voyages") return paths.voyages;
    return paths.captures;
  }

  function normalizeRecordingKind(kind) {
    if (kind === "voyages") return "voyages";
    return kind === "clips" ? "clips" : "logs";
  }

  function recordingKindForPath(filePath) {
    if (path.dirname(filePath) === paths.clips) return "clips";
    if (path.dirname(filePath) === paths.voyages) return "voyages";
    return "logs";
  }

  async function extractClip({ fileName, kind, from, to, label, clipName }) {
    await flushRecordingStream();
    const inputPath = fileName
      ? await resolveCaptureOrClip(fileName, kind)
      : path.join(recordingDirectoryForKind(kind), "__all-log-files__.jsonl");
    const { fromMs, toMs } = await resolveClipTimes(inputPath, from, to);
    const sourceFiles = await clipSourceFiles(inputPath, fromMs, toMs);
    if (!sourceFiles.length) {
      const range = await fullLogRange(inputPath);
      throw new Error(`No log data found between ${new Date(fromMs).toISOString()} and ${new Date(toMs).toISOString()}. Available logs run from ${range.from || "unknown"} to ${range.to || "unknown"}.`);
    }
    const outputName = await uniqueClipFileName(clipName || label || "clip");
    const outputPath = path.join(paths.clips, outputName);
    const stream = fs.createWriteStream(outputPath, { flags: "w" });
    let lines = 0;
    let first = null;
    let last = null;

    for (const segment of sourceFiles) {
      await readEnvelopes(segment, async (envelope) => {
        const ts = Date.parse(envelope.capturedAt);
        if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) return;
        stream.write(`${JSON.stringify(envelope)}\n`);
        lines += 1;
        first = first || envelope.capturedAt;
        last = envelope.capturedAt;
      });
    }

    await new Promise((resolve) => stream.end(resolve));
    if (!lines) {
      await fs.promises.unlink(outputPath).catch(() => {});
      const range = await fullLogRange(inputPath);
      throw new Error(`No deltas found between ${new Date(fromMs).toISOString()} and ${new Date(toMs).toISOString()}. Available logs run from ${range.from || "unknown"} to ${range.to || "unknown"}.`);
    }
    addEvent("clip-extracted", `${outputName} (${lines} deltas)`);
    queueRecordingMetadata(outputPath, "clip-extracted");
    return { fileName: outputName, lines, from: first, to: last, bytes: fileSize(outputPath) };
  }

  async function resolveClipTimes(inputPath, from, to) {
    let fromMs = Date.parse(from);
    let toMs = Date.parse(to);
    if (!from || !to) {
      const range = await fullLogRange(inputPath);
      if (!from) fromMs = Date.parse(range.from);
      if (!to) toMs = Date.parse(range.to);
    }
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new Error("Enter a start and end time for the clip");
    }
    if (toMs <= fromMs) {
      throw new Error("Clip end time must be after the start time");
    }
    return { fromMs, toMs };
  }

  async function fullLogRange(inputPath) {
    let first = null;
    let last = null;
    for (const segment of await clipSourceFiles(inputPath, -Infinity, Infinity)) {
      const statsInfo = await fs.promises.stat(segment).catch(() => null);
      const meta = statsInfo?.isFile()
        ? await recordingListMetadata(segment, {
            name: path.basename(segment),
            size: statsInfo.size,
            mtimeMs: statsInfo.mtimeMs,
          })
        : { from: null, to: null };
      if (meta.from && (!first || Date.parse(meta.from) < Date.parse(first))) first = meta.from;
      if (meta.to && (!last || Date.parse(meta.to) > Date.parse(last))) last = meta.to;
    }
    return { from: first, to: last };
  }

  async function flushRecordingStream() {
    if (!recording?.stream || recording.stream.destroyed || recording.stream.writableEnded) return;
    await new Promise((resolve, reject) => {
      recording.stream.write("", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async function uniqueClipFileName(value) {
    const base = String(value || "clip")
      .replace(/\.(jsonl|jsonl\.gz)$/i, "")
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-|-$/g, "") || "clip";
    let fileName = `${base}.jsonl`;
    let index = 2;
    while (await fileExists(path.join(paths.clips, fileName))) {
      fileName = `${base}-${index}.jsonl`;
      index += 1;
    }
    return fileName;
  }

  async function clipSourceFiles(inputPath, fromMs, toMs) {
    const directory = path.dirname(inputPath);
    const files = await listRecordingFiles(directory);
    const entries = [];
    for (const file of files) {
      const fullPath = path.join(directory, file.name);
      const meta = await recordingListMetadata(fullPath, file);
      const fileFromMs = Date.parse(meta.from);
      const endMs = Date.parse(meta.to);
      if (!Number.isFinite(fileFromMs)) continue;
      const overlapsStart = !Number.isFinite(endMs) || endMs >= fromMs;
      const overlapsEnd = fileFromMs <= toMs;
      if (!overlapsStart || !overlapsEnd) continue;
      entries.push({ fullPath, name: file.name, fromMs: fileFromMs, endMs });
    }
    entries.sort((a, b) => a.fromMs - b.fromMs || a.name.localeCompare(b.name));
    return entries.map((entry) => entry.fullPath);
  }

  async function buildStatus() {
    const [captures, clips, voyages, disk] = await Promise.all([
      listCaptures({ fast: true }),
      listClips({ fast: true }),
      listVoyages(),
      readDiskStatus(paths.root),
    ]);
    return {
      ok: true,
      plugin: plugin.id,
      version: packageInfo.version,
      timestamp: new Date().toISOString(),
      options,
      paths,
      recording: getRecordingSummary(),
      playback: getPlaybackSummary(),
      buffer: {
        currentFile: currentBuffer?.fileName || null,
        linesInCurrentFile: currentBuffer?.lines || 0,
      },
      captures,
      clips,
      voyages,
      disk,
      stats,
      recentEvents,
    };
  }

  async function listCaptures(listOptions = {}) {
    return listRecordings(paths.captures, listOptions);
  }

  async function listClips(listOptions = {}) {
    return listRecordings(paths.clips, listOptions);
  }

  async function listVoyages() {
    const entries = await fs.promises.readdir(paths.voyages, { withFileTypes: true }).catch(() => []);
    const result = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(zip|tar\.gz|tgz)$/i.test(entry.name)) continue;
      const fullPath = path.join(paths.voyages, entry.name);
      const info = await fs.promises.stat(fullPath).catch(() => null);
      if (!info?.isFile()) continue;
      const index = await readVoyageZipIndex(fullPath);
      result.push({
        fileName: entry.name,
        bytes: info.size,
        comment: normalizeComment(index?.comment),
        startedAt: index?.startedAt || null,
        stoppedAt: index?.stoppedAt || null,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      });
    }
    result.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    return result;
  }

  async function listRecordings(directory, listOptions = {}) {
    const files = await listRecordingFiles(directory);
    const result = [];
    for (const file of files.reverse()) {
      const fullPath = path.join(directory, file.name);
      const meta = listOptions.fast
        ? fastRecordingListMetadata(fullPath, file)
        : await recordingListMetadata(fullPath, file);
      result.push({
        fileName: file.name,
        startedAt: recordingStartedAtFromFileName(file.name),
        bytes: file.size,
        compressed: isCompressedLogName(file.name),
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        lines: meta.lines,
        from: meta.from,
        to: meta.to,
        metadataPending: meta.metadataPending === true,
      });
    }
    return result;
  }

  function fastRecordingListMetadata(fullPath, file) {
    if (recording?.filePath === fullPath) {
      return {
        lines: recording.lines,
        from: recording.from,
        to: recording.to,
      };
    }

    const cacheKey = `${fullPath}:${file.size}:${file.mtimeMs}`;
    const cached = recordingMetadataCache.get(cacheKey);
    if (cached) return cached;

    const sidecar = readRecordingMetadataFileSync(fullPath, file);
    if (sidecar) {
      recordingMetadataCache.set(cacheKey, sidecar);
      return sidecar;
    }

    queueRecordingMetadata(fullPath, "metadata-missing");

    return {
      lines: null,
      from: null,
      to: null,
      metadataPending: true,
    };
  }

  async function recordingListMetadata(fullPath, file) {
    if (recording?.filePath === fullPath) {
      return {
        lines: recording.lines,
        from: recording.from,
        to: recording.to,
      };
    }

    const cacheKey = `${fullPath}:${file.size}:${file.mtimeMs}`;
    const cached = recordingMetadataCache.get(cacheKey);
    if (cached) return cached;

    const sidecar = await readRecordingMetadataFile(fullPath, file);
    if (sidecar) {
      recordingMetadataCache.set(cacheKey, sidecar);
      return sidecar;
    }

    for (const key of recordingMetadataCache.keys()) {
      if (key.startsWith(`${fullPath}:`)) recordingMetadataCache.delete(key);
    }
    const meta = await scanFile(fullPath, Infinity, false);
    await writeRecordingMetadataFile(fullPath, null, meta);
    return meta;
  }

  function queueRecordingMetadata(filePath, reason) {
    if (!filePath || recording?.filePath === filePath) return;
    if (recordingMetadataJobs.has(filePath)) return;
    recordingMetadataJobs.add(filePath);
    setTimeout(() => {
      generateRecordingMetadata(filePath, reason)
        .catch((error) => logError("metadata generation failed", error))
        .finally(() => recordingMetadataJobs.delete(filePath));
    }, 0);
  }

  async function generateRecordingMetadata(filePath, reason) {
    const statsInfo = await fs.promises.stat(filePath).catch(() => null);
    if (!statsInfo?.isFile() || statsInfo.size === 0) return null;
    const existing = await readRecordingMetadataFile(filePath, {
      name: path.basename(filePath),
      size: statsInfo.size,
      mtimeMs: statsInfo.mtimeMs,
    });
    if (existing) return existing;
    const meta = await scanFile(filePath, Infinity, false);
    await writeRecordingMetadataFile(filePath, statsInfo, meta);
    addEvent("metadata", `Indexed ${path.basename(filePath)}${reason ? ` (${reason})` : ""}`);
    return meta;
  }

  function readRecordingMetadataFileSync(filePath, file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(recordingMetadataPath(filePath), "utf8"));
      return normalizeRecordingMetadata(parsed, file);
    } catch (_error) {
      return null;
    }
  }

  async function readRecordingMetadataFile(filePath, file) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(recordingMetadataPath(filePath), "utf8"));
      return normalizeRecordingMetadata(parsed, file);
    } catch (_error) {
      return null;
    }
  }

  function normalizeRecordingMetadata(parsed, file) {
    if (!parsed || parsed.version !== RECORDING_METADATA_VERSION) return null;
    if (parsed.fileName !== file.name) return null;
    if (parsed.bytes !== file.size) return null;
    if (Math.abs(Number(parsed.mtimeMs) - Number(file.mtimeMs)) > 1) return null;
    return {
      lines: Number.isFinite(parsed.lines) ? parsed.lines : null,
      from: parsed.from || null,
      to: parsed.to || null,
    };
  }

  async function writeRecordingMetadataFile(filePath, statsInfo, meta) {
    const fileStats = statsInfo || (await fs.promises.stat(filePath).catch(() => null));
    if (!fileStats?.isFile()) return null;
    const payload = {
      version: RECORDING_METADATA_VERSION,
      fileName: path.basename(filePath),
      startedAt: recordingStartedAtFromFileName(path.basename(filePath)),
      bytes: fileStats.size,
      mtimeMs: fileStats.mtimeMs,
      compressed: isCompressedLogName(filePath),
      lines: Number.isFinite(meta?.lines) ? meta.lines : 0,
      from: meta?.from || null,
      to: meta?.to || null,
      generatedAt: new Date().toISOString(),
    };
    const metadataPath = recordingMetadataPath(filePath);
    const tempPath = `${metadataPath}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    await fs.promises.rename(tempPath, metadataPath);
    const cacheKey = `${filePath}:${fileStats.size}:${fileStats.mtimeMs}`;
    recordingMetadataCache.set(cacheKey, {
      lines: payload.lines,
      from: payload.from,
      to: payload.to,
    });
    return payload;
  }

  async function nextRecordingFileAfter(directory, current) {
    const files = await listRecordingFiles(directory);
    const currentEndMs = Date.parse(current.to || current.current);
    const entries = [];
    for (const file of files) {
      if (file.name === current.fileName) continue;
      const fullPath = path.join(directory, file.name);
      const meta = await recordingListMetadata(fullPath, file);
      const fromMs = Date.parse(meta.from);
      if (!Number.isFinite(fromMs)) continue;
      if (Number.isFinite(currentEndMs) && fromMs < currentEndMs) continue;
      entries.push({ ...file, fromMs, from: meta.from, to: meta.to });
    }
    entries.sort((a, b) => a.fromMs - b.fromMs || a.name.localeCompare(b.name));
    return entries[0] || null;
  }

  async function scanFile(filePath, maxLines = Infinity, buildIndex = false) {
    const canUseOffsets = buildIndex && !isCompressedLogName(filePath);
    const meta = {
      lines: 0,
      from: null,
      to: null,
      offsets: buildIndex ? [] : undefined,
      times: buildIndex ? [] : undefined,
      compressed: isCompressedLogName(filePath),
    };
    await readEnvelopes(filePath, async (envelope) => {
      meta.lines += 1;
      updateMetadataRange(meta, envelope.capturedAt);
      if (buildIndex) {
        meta.offsets.push(canUseOffsets ? envelope.__offset : null);
        meta.times.push(Date.parse(envelope.capturedAt));
      }
      if (meta.lines >= maxLines && maxLines !== Infinity) {
        meta.partial = true;
      }
    }, maxLines, { includeOffsets: buildIndex });
    return meta;
  }

  function updateMetadataRange(meta, capturedAt) {
    const ts = Date.parse(capturedAt);
    if (!Number.isFinite(ts)) return;
    const fromMs = Date.parse(meta.from);
    const toMs = Date.parse(meta.to);
    if (!Number.isFinite(fromMs) || ts < fromMs) meta.from = capturedAt;
    if (!Number.isFinite(toMs) || ts > toMs) meta.to = capturedAt;
  }

  async function listJsonlFiles(directory) {
    return listFilesBySuffix(directory, [".jsonl"]);
  }

  async function listRecordingFiles(directory) {
    return listFilesBySuffix(directory, [".jsonl", ".jsonl.gz"]);
  }

  async function listFilesBySuffix(directory, suffixes) {
    await fs.promises.mkdir(directory, { recursive: true });
    const names = await fs.promises.readdir(directory);
    const files = [];
    for (const name of names.filter((entry) => suffixes.some((suffix) => entry.endsWith(suffix)))) {
      const statsInfo = await fs.promises.stat(path.join(directory, name)).catch(() => null);
      if (statsInfo?.isFile()) {
        files.push({
          name,
          size: statsInfo.size,
          mtimeMs: statsInfo.mtimeMs,
        });
      }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function readEnvelopes(filePath, onEnvelope, maxLines = Infinity, readOptions = {}) {
    const stream = createLogReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lines = 0;
    let offset = 0;
    try {
      for await (const line of rl) {
        const currentOffset = offset;
        offset += Buffer.byteLength(line, "utf8") + 1;
        if (!line.trim()) continue;
        lines += 1;
        try {
          const envelope = parseLogLine(line);
          if (readOptions.includeOffsets) envelope.__offset = currentOffset;
          await onEnvelope(envelope);
        } catch (error) {
          stats.parseErrors += 1;
          app.debug(`[${plugin.id}] skipped invalid line in ${filePath}: ${error.message}`);
        }
        if (lines >= maxLines) {
          break;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  function parseLogLine(line) {
    const parsed = JSON.parse(line);
    if (parsed && parsed.delta && parsed.capturedAt) return parsed;
    return {
      capturedAt: getDeltaTimestamp(parsed) || new Date().toISOString(),
      delta: parsed,
    };
  }

  async function readEnvelopeAtLine(filePath, lineIndex) {
    const offset = playback.offsets?.[lineIndex];
    if (!Number.isFinite(offset)) return readEnvelopeByScan(filePath, lineIndex);
    const line = await readLineAtOffset(filePath, offset);
    return line ? parseLogLine(line) : null;
  }

  async function readEnvelopeByScan(filePath, lineIndex) {
    let found = null;
    let index = 0;
    await readEnvelopes(filePath, async (envelope) => {
      if (index === lineIndex) found = envelope;
      index += 1;
    }, lineIndex + 1);
    return found;
  }

  function findLineAtOrAfter(targetMs) {
    const times = playback.times || [];
    let low = 0;
    let high = times.length - 1;
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (times[mid] >= targetMs) {
        best = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return {
      lineIndex: best,
      capturedAt: Number.isFinite(times[best])
        ? new Date(times[best]).toISOString()
        : playback.from,
    };
  }

  async function resolveCaptureOrClip(fileName, kind) {
    if (!fileName) throw new Error("No capture selected");
    const normalizedKind = kind ? normalizeRecordingKind(kind) : null;
    const candidates = normalizedKind
      ? [path.join(recordingDirectoryForKind(normalizedKind), fileName)]
      : [
          path.join(paths.captures, fileName),
          path.join(paths.clips, fileName),
        ];
    for (const candidate of candidates) {
      const statsInfo = await fs.promises.stat(candidate).catch(() => null);
      if (statsInfo?.isFile()) return candidate;
    }
    throw new Error(`Capture not found: ${fileName}`);
  }

  function createPlaybackState() {
    return {
      loaded: false,
      active: false,
      paused: false,
      fileName: null,
      filePath: null,
      sourceDirectory: null,
      sourceKind: "logs",
      voyageFileName: null,
      displayFileName: null,
      totalLines: 0,
      cursor: 0,
      from: null,
      to: null,
      current: null,
      rate: 1,
      previousTs: null,
      sourceAnchorMs: null,
      wallAnchorMs: null,
      lastLineWallMs: null,
      timer: null,
      lastReason: "not loaded",
      offsets: [],
      times: [],
    };
  }

  function getRecordingSummary() {
    if (!recording) return null;
    return {
      fileName: recording.fileName,
      startedAt: recording.startedAt,
      backfillMinutes: recording.backfillMinutes,
      backfilled: recording.backfilled,
      lines: recording.lines,
      from: recording.from,
      to: recording.to,
      bytes: fileSize(recording.filePath),
    };
  }

  function getPlaybackSummary() {
    return {
      loaded: playback.loaded,
      active: playback.active,
      paused: playback.paused,
      fileName: playback.fileName,
      displayFileName: playback.displayFileName || playback.fileName,
      sourceKind: playback.sourceKind,
      voyageFileName: playback.voyageFileName,
      totalLines: playback.totalLines,
      cursor: playback.cursor,
      from: playback.from,
      to: playback.to,
      current: playback.current,
      rate: playback.rate,
      lastReason: playback.lastReason,
      compressed: isCompressedLogName(playback.fileName || ""),
      autoAdvance: options.autoAdvancePlayback,
    };
  }

  function publishPlaybackClock(active) {
    app.handleMessage(plugin.id, {
      context: "vessels.self",
      updates: [
        {
          timestamp: new Date().toISOString(),
          values: [
            {
              path: PLAYBACK_CLOCK_PATH,
              value: active
                ? {
                    active: true,
                    capturedAt: playback.current,
                    fileName: playback.fileName,
                    displayFileName: playback.displayFileName || playback.fileName,
                    sourceKind: playback.sourceKind,
                    voyageFileName: playback.voyageFileName,
                    playing: playback.active,
                    rate: playback.rate,
                  }
                : {
                    active: false,
                    fileName: playback.fileName,
                    displayFileName: playback.displayFileName || playback.fileName,
                    sourceKind: playback.sourceKind,
                    voyageFileName: playback.voyageFileName,
                  },
            },
          ],
        },
      ],
    });
  }

  function parseSeekTarget(target) {
    if (typeof target === "number") {
      const base = Date.parse(playback.from);
      if (!Number.isFinite(base)) throw new Error("Capture start time is unknown");
      return base + target * 1000;
    }
    const parsed = Date.parse(target);
    if (!Number.isFinite(parsed)) throw new Error("Seek target is invalid");
    return parsed;
  }

  function updateProviderStatus() {
    const recordingText = recording ? `recording ${recording.fileName}` : "buffering";
    const playbackText = playback.active ? `, playing ${playback.fileName}` : "";
    app.setPluginStatus(
      `CapturePlus v${packageInfo.version}: ${recordingText}${playbackText}`,
    );
  }

  function addEvent(event, message) {
    recentEvents.unshift({ ts: new Date().toISOString(), event, message });
    recentEvents.splice(20);
  }

  function logError(context, error) {
    if (String(context || "").includes("compression")) stats.compressionErrors += 1;
    const message = error?.stack || error?.message || String(error);
    app.error(`[${plugin.id}] ${context}: ${message}`);
    addEvent("error", `${context}: ${error.message || error}`);
  }

  function logInfo(message) {
    console.log(`[${plugin.id}] ${message}`);
  }
};

function createLogReadStream(filePath) {
  if (!isCompressedLogName(filePath)) {
    return fs.createReadStream(filePath, { encoding: "utf8" });
  }
  const source = fs.createReadStream(filePath);
  const stream = source.pipe(zlib.createGunzip());
  const destroyGunzip = stream.destroy.bind(stream);
  stream.destroy = (error) => {
    source.destroy();
    return destroyGunzip(error);
  };
  source.on("error", (error) => stream.destroy(error));
  stream.setEncoding("utf8");
  return stream;
}

function isCompressedLogName(value) {
  return String(value || "").endsWith(".jsonl.gz");
}

function recordingMetadataPath(filePath) {
  return `${filePath}.meta.json`;
}

async function fileExists(filePath) {
  const statsInfo = await fs.promises.stat(filePath).catch(() => null);
  return Boolean(statsInfo?.isFile());
}

async function directoryExists(filePath) {
  const statsInfo = await fs.promises.stat(filePath).catch(() => null);
  return Boolean(statsInfo?.isDirectory());
}

function safeReplayDirectoryName(fileName) {
  return safeBaseName(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function assertSafeZipEntries(filePath, fileName) {
  let stdout = "";
  try {
    const result = await execFile("unzip", ["-Z1", filePath], {
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout || "";
  } catch (error) {
    throw new Error(`Unable to inspect voyage ${fileName}: ${error.message || error}`);
  }
  const unsafe = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .find((entry) => path.isAbsolute(entry) || entry.split(/[\\/]+/).includes(".."));
  if (unsafe) {
    throw new Error(`Voyage ${fileName} contains an unsafe archive path: ${unsafe}`);
  }
}

async function readVoyageZipIndex(filePath) {
  try {
    const result = await execFile("unzip", ["-p", filePath, "index.json"], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout || "");
  } catch (_error) {
    return null;
  }
}

function normalizeComment(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, 2000);
}

function getDeltaTimestamp(delta) {
  const firstUpdate = Array.isArray(delta?.updates) ? delta.updates[0] : null;
  return firstUpdate?.timestamp || delta?.timestamp || null;
}

function replayDeltaAsLiveInputs(delta, timestamp = new Date().toISOString()) {
  if (!delta || typeof delta !== "object" || !Array.isArray(delta.updates)) return delta;
  const updates = delta.updates
    .map((update) => replayUpdateAsLiveInputs(update, timestamp))
    .filter(Boolean);
  if (!updates.length) return null;
  return {
    ...delta,
    updates,
  };
}

function replayUpdateAsLiveInputs(update, timestamp) {
  if (!update || typeof update !== "object") return null;
  const values = Array.isArray(update.values)
    ? update.values
        .filter((entry) => shouldReplayInputPath(entry?.path))
        .map((entry) => replayEntryAsLiveInput(entry, timestamp))
        .filter(Boolean)
    : [];
  if (!values.length) return null;
  return {
    ...update,
    timestamp,
    values,
  };
}

function replayEntryAsLiveInput(entry, timestamp) {
  const value = refreshEmbeddedSignalKTimestamp(
    stripDerivedReplayFields(entry.value),
    timestamp,
  );
  if (isEmptyReplayValue(value)) return null;
  return {
    ...entry,
    value,
  };
}

function shouldReplayInputPath(pathName) {
  const pathText = String(pathName || "");
  if (!pathText) return true;
  if (pathText === PLAYBACK_CLOCK_PATH) return false;
  if (pathText === "notifications" || pathText.startsWith("notifications.")) return false;
  if (pathText === "plugins" || pathText.startsWith("plugins.")) return false;
  return true;
}

function stripDerivedReplayFields(value) {
  if (Array.isArray(value)) return value.map(stripDerivedReplayFields);
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.entries(value).forEach(([key, child]) => {
    if (key === "plugins" || key === "notifications") return;
    output[key] = stripDerivedReplayFields(child);
  });
  return output;
}

function refreshEmbeddedSignalKTimestamp(value, timestamp) {
  if (Array.isArray(value)) return value.map((item) => refreshEmbeddedSignalKTimestamp(item, timestamp));
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.entries(value).forEach(([key, child]) => {
    if (key === "timestamp" && typeof child === "string") {
      output[key] = timestamp;
    } else {
      output[key] = refreshEmbeddedSignalKTimestamp(child, timestamp);
    }
  });
  return output;
}

function isEmptyReplayValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function unwrapValue(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return value.value;
  }
  return value;
}

function formatFileTime(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function recordingStartedAtFromFileName(fileName) {
  const match = String(fileName || "").match(/^capture-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl(?:\.gz)?$/);
  if (!match) return null;
  const [, date, hour, minute, second, millisecond] = match;
  return `${date}T${hour}:${minute}:${second}.${millisecond}Z`;
}

function safeBaseName(value) {
  const fileName = path.basename(String(value || ""));
  if (!fileName || fileName === "." || fileName === "..") {
    throw new Error("Invalid file name");
  }
  return fileName;
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizePlaybackRate(value, fallback = 1) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "max" || text === "maximum") return "max";
  if (fallback === "max" && (value === undefined || value === null || value === "")) return "max";
  return clampNumber(value, fallback === "max" ? 1 : fallback, 0.1, 20);
}

function calculatePlaybackDelayMs({
  nextSourceMs,
  sourceAnchorMs,
  wallAnchorMs,
  rate,
  nowMs,
}) {
  if (rate === "max") return 0;
  const numericRate = Number(rate || 1);
  if (
    !Number.isFinite(nextSourceMs) ||
    !Number.isFinite(sourceAnchorMs) ||
    !Number.isFinite(wallAnchorMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(numericRate) ||
    numericRate <= 0
  ) {
    return 0;
  }
  const targetWallMs = wallAnchorMs + Math.max(0, nextSourceMs - sourceAnchorMs) / numericRate;
  return Math.max(0, targetWallMs - nowMs);
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

async function readDiskStatus(directory) {
  try {
    const statsInfo = await fs.promises.statfs(directory);
    return {
      path: directory,
      totalBytes: statsInfo.blocks * statsInfo.bsize,
      availableBytes: statsInfo.bavail * statsInfo.bsize,
      freeBytes: statsInfo.bfree * statsInfo.bsize,
    };
  } catch (error) {
    return { path: directory, error: error.message };
  }
}

async function readLineAtOffset(filePath, offset) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const chunks = [];
    let position = offset;
    let done = false;
    while (!done) {
      const buffer = Buffer.alloc(65536);
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      const slice = buffer.subarray(0, result.bytesRead);
      const newline = slice.indexOf(10);
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline));
        done = true;
      } else {
        chunks.push(slice);
        position += result.bytesRead;
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

module.exports._test = {
  calculatePlaybackDelayMs,
  normalizePlaybackRate,
  replayDeltaAsLiveInputs,
  shouldReplayInputPath,
};
