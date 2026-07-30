const fs = require("node:fs");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const readline = require("node:readline");
const { Writable } = require("node:stream");
const util = require("node:util");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const AdmZip = require("adm-zip");
const yauzl = require("yauzl");
const packageInfo = require("../package.json");
const { createPlaybackOperation } = require("./playback-operation");
const {
  DEFAULT_SENSOR_SOURCE_IDS,
  DEFAULT_SENSOR_SOURCE_PREFIXES,
  PLAYBACK_MODE_SENSOR_SOURCES,
  createFilterStats,
  createSourcePolicy,
  mergeFilterStats,
  normalizePlaybackMode,
  normalizeSensorSourceIds,
  normalizeSensorSourcePrefixes,
  replayDeltaWithPolicy,
  shouldReplayInputPath,
  sourceCatalogFromDelta,
  sourceIdentityForUpdate,
  sourceMatchesPhysicalPolicy,
} = require("./playback-source-policy");

const PLAYBACK_CLOCK_PATH = "plugins.ajrmMarineLogger.playback";
const POWER_INTENT_PATH = "plugins.ajrmMarinePiController.power.intent";
const DEFAULT_LOG_DIRECTORY = "~/AJRMMarineLogs";
const LEGACY_LOG_DIRECTORY = ["~/Capture", "PlusLogs"].join("");
const RECORDING_METADATA_VERSION = 1;
const REPLAY_INDEX_VERSION = 1;
const REPLAY_CACHE_MANIFEST_VERSION = 1;
const GIBIBYTE = 1024 ** 3;
const REPLAY_CALCULATION_FLUSH_MS = 3000;
const REPLAY_CALCULATION_FLUSH_MAX_MS = 15000;
const DEFAULT_REPLAY_ECHO_WINDOW_MS = 15000;
const MAX_VOYAGE_INDEX_BYTES = 2 * 1024 * 1024;
const AJRM_MARINE_LOGGER_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineLoggerApi");
const AJRM_MARINE_CAPTURE_API_REGISTRY = Symbol.for("mcdonaldajr.ajrmMarineCaptureApi");
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
  let playbackLoadJob = null;
  let activeReplayInjection = null;
  const recentReplayInjections = new Map();
  const recentReplayUpdateEvidence = new Map();
  let runStartedAtMs = Date.now();
  let startupRecoveryGeneration = 0;
  let startupRecoveryPromise = Promise.resolve();
  let replayCacheMaintenancePromise = null;
  let lastReplayCacheMaintenanceMs = 0;
  let replayCacheLoadInProgress = false;
  let replayCacheStatus = {
    entries: 0,
    bytes: 0,
    removedEntries: 0,
    removedBytes: 0,
    updatedAt: null,
  };
  const playbackOperation = createPlaybackOperation();
  const recordingMetadataCache = new Map();
  const voyageMetadataCache = new Map();
  const voyageMetadataJobs = new Map();
  const recordingMetadataFailures = new Map();
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
    replayInputsCaptured: 0,
    replayOutputsCaptured: 0,
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
        default: DEFAULT_LOG_DIRECTORY,
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
      replayWarmupMinutes: {
        type: "integer",
        title: "Voyage replay warm-up in minutes",
        description:
          "When loading a voyage, start replay this many minutes before the voyage start if that data exists. This lets AIS/static data settle without replaying the full debug backfill.",
        default: 7,
        minimum: 0,
        maximum: 1440,
      },
      replayFullBackfill: {
        type: "boolean",
        title: "Replay full voyage backfill",
        description:
          "Debug option. When enabled, voyage replay starts at the earliest bundled capture record instead of the warm-up point.",
        default: false,
      },
      replayCacheMaxGigabytes: {
        type: "integer",
        title: "Maximum replay cache size in GB",
        description:
          "Logger removes the least-recently-used inactive replay caches when this limit is exceeded.",
        default: 8,
        minimum: 1,
        maximum: 1024,
      },
      replayCacheMinimumFreeGigabytes: {
        type: "integer",
        title: "Minimum free disk space after replay caching in GB",
        description:
          "Logger removes least-recently-used inactive replay caches when free disk space falls below this reserve.",
        default: 4,
        minimum: 0,
        maximum: 1024,
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
    const recoveryGeneration = startupRecoveryGeneration + 1;
    startupRecoveryGeneration = recoveryGeneration;
    const startupRecoverySnapshot = snapshotStartupRecoveryFiles();
    options = { ...options, ...readSavedSettings() };
    clearStartupBufferFiles();
    rotateBuffer(new Date());
    pruneBuffer();
    startupRecoveryPromise = recoverStaleCaptureFiles(
      startupRecoverySnapshot,
      recoveryGeneration,
      startupRecoveryPromise,
    );
    deltaListener = (delta) => onLiveDelta(delta);
    app.signalk.on("delta", deltaListener);
    const api = {
      startCapture: ({ backfillMinutes } = {}) =>
        startRecording(
          clampInt(backfillMinutes, options.backfillMinutes, 0, options.maxBackfillMinutes),
        ),
      startReplayResultCapture: (metadata = {}) =>
        startReplayResultRecording(metadata),
      stopReplayResultCapture: (reason = "recomputed replay capture stopped") =>
        stopReplayResultRecording(reason),
      abortReplayResultCapture: (reason = "recomputed replay capture aborted") =>
        abortReplayResultRecording(reason),
      startPlayback: (rate = 1) => {
        startPlayback(normalizePlaybackRate(rate, playback.rate || 1));
        return getPlaybackSummary();
      },
      stopCapture: (reason = "external stopped") => {
        assertNormalCaptureCanStop();
        return stopRecording(reason);
      },
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
        if (Date.now() - lastReplayCacheMaintenanceMs >= 5 * 60 * 1000) {
          requestReplayCacheMaintenance();
        }
      } catch (error) {
        logError("maintenance failed", error);
      }
    }, 5000);

    statusTimer = setInterval(updateProviderStatus, 10000);
    updateProviderStatus();
    addEvent("started", `AJRM Marine Logger v${packageInfo.version} started`);
    requestReplayCacheMaintenance();
  };

  plugin.stop = () => {
    startupRecoveryGeneration += 1;
    if (deltaListener) {
      app.signalk.removeListener("delta", deltaListener);
      deltaListener = null;
    }
    clearInterval(maintenanceTimer);
    clearInterval(statusTimer);
    maintenanceTimer = null;
    statusTimer = null;
    stopPlayback("plugin stopped", { force: true });
    recentReplayInjections.clear();
    recentReplayUpdateEvidence.clear();
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

    router.get(`${prefix}/playback/load/status`, async (req, res) => {
      const requestedId = String(req.query?.id || "");
      if (!playbackLoadJob || (requestedId && playbackLoadJob.id !== requestedId)) {
        res.json({ ok: true, load: { state: "idle" } });
        return;
      }
      res.json({ ok: playbackLoadJob.state !== "error", load: playbackLoadJobSummary() });
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
        assertNormalCaptureCanStop();
        res.json({ ok: true, recording: stopRecording("user stopped") });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/result-capture/start`, write(async (req, res) => {
      try {
        res.json({
          ok: true,
          recording: await startReplayResultRecording(req.body || {}),
        });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/result-capture/stop`, write(async (_req, res) => {
      try {
        res.json({
          ok: true,
          recording: await stopReplayResultRecording(
            "recomputed replay capture stopped",
          ),
        });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/result-capture/abort`, write(async (req, res) => {
      try {
        const requestedReason = String(req.body?.reason || "").trim();
        res.json({
          ok: true,
          recording: await abortReplayResultRecording(
            requestedReason || "recomputed replay capture aborted by user",
          ),
        });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/load`, write(async (req, res) => {
      try {
        if (recording) {
          res.status(409).json({ ok: false, error: "Stop recording before playback" });
          return;
        }
        const fileName = safeBaseName(req.body?.file);
        const playbackOptions = {
          includeFullBackfill: req.body?.includeFullBackfill === true,
          mode: normalizePlaybackMode(req.body?.mode),
          sensorSourceIds: normalizeSensorSourceIds(req.body?.sensorSourceIds),
          sensorSourcePrefixes: normalizeSensorSourcePrefixes(
            req.body?.sensorSourcePrefixes,
          ),
        };
        if (req.body?.async === true) {
          const load = startPlaybackLoadJob(fileName, req.body?.kind, playbackOptions);
          res.json({ ok: true, load });
          return;
        }
        const result = await loadPlayback(fileName, req.body?.kind, playbackOptions);
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

    router.post(`${prefix}/playback/mode`, write((req, res) => {
      try {
        setPlaybackMode({
          mode: req.body?.mode,
          sensorSourceIds: req.body?.sensorSourceIds,
          sensorSourcePrefixes: req.body?.sensorSourcePrefixes,
        });
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
      try {
        pausePlayback("paused");
        res.json({ ok: true, playback: getPlaybackSummary() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.post(`${prefix}/playback/stop`, write((_req, res) => {
      try {
        stopPlayback("stopped");
        res.json({ ok: true, playback: getPlaybackSummary() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
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
        if (req.body?.replayWarmupMinutes !== undefined) {
          options.replayWarmupMinutes = clampInt(
            req.body.replayWarmupMinutes,
            options.replayWarmupMinutes,
            0,
            1440,
          );
          addEvent("settings", `Voyage replay warm-up set to ${options.replayWarmupMinutes} minutes`);
        }
        if (typeof req.body?.replayFullBackfill === "boolean") {
          options.replayFullBackfill = req.body.replayFullBackfill;
          addEvent(
            "settings",
            `Voyage full-backfill replay ${options.replayFullBackfill ? "enabled" : "disabled"}`,
          );
        }
        saveRuntimeSettings();
        res.json({ ok: true, options, playback: getPlaybackSummary() });
      } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
      }
    }));

    router.get(`${prefix}/files/:kind/:file/download`, async (req, res) => {
      let captureDownload = null;
      let responseClosed = false;
      const cleanupCaptureDownload = () => {
        if (captureDownload) captureDownload.cleanup().catch(() => {});
      };
      res.once("close", () => {
        responseClosed = true;
        cleanupCaptureDownload();
      });
      try {
        const kind = normalizeRecordingKind(req.params.kind);
        const fileName = safeBaseName(req.params.file);
        if (kind === "voyages") {
          captureDownload = await prepareCaptureVoyageDownload(fileName);
          if (captureDownload) {
            if (responseClosed || res.destroyed) {
              await captureDownload.cleanup();
              return;
            }
            res.download(
              captureDownload.path,
              `logger-${captureDownload.fileName}`,
              cleanupCaptureDownload,
            );
            return;
          }
          throw new Error("AJRM Marine Capture portable download API is unavailable; cannot safely download a complete voyage bundle from Logger.");
        }
        const filePath = path.join(recordingDirectoryForKind(kind), fileName);
        const statsInfo = await fs.promises.stat(filePath).catch(() => null);
        if (!statsInfo?.isFile()) {
          res.status(404).json({ ok: false, error: `File not found: ${fileName}` });
          return;
        }
        res.download(filePath, fileName);
      } catch (error) {
        cleanupCaptureDownload();
        if (!responseClosed && !res.destroyed && !res.headersSent) {
          res.status(400).json({ ok: false, error: error.message });
        }
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
          "AJRM Marine Logger control requires Signal K read/write or admin access. Approve this device in Access Requests/Devices, or log in as an admin.",
      });
      return undefined;
    };
  }

  function normalizeOptions(value) {
    return {
      logDirectory: expandHome(String(value.logDirectory || defaultLogDirectory())),
      bufferMinutes: clampInt(value.bufferMinutes, 30, 1, 1440),
      segmentSeconds: clampInt(value.segmentSeconds, 60, 10, 3600),
      maxBackfillMinutes: clampInt(value.maxBackfillMinutes, 120, 1, 1440),
      backfillMinutes: clampInt(value.backfillMinutes, 30, 0, 1440),
      captureSegmentMinutes: clampInt(value.captureSegmentMinutes, 60, 1, 1440),
      compressCompletedCaptures: value.compressCompletedCaptures !== false,
      autoAdvancePlayback: value.autoAdvancePlayback !== false,
      autoStartCapture: value.autoStartCapture === true,
      replayWarmupMinutes: clampInt(value.replayWarmupMinutes, 7, 0, 1440),
      replayFullBackfill: value.replayFullBackfill === true,
      replayCacheMaxGigabytes: clampInt(
        value.replayCacheMaxGigabytes,
        8,
        1,
        1024,
      ),
      replayCacheMinimumFreeGigabytes: clampInt(
        value.replayCacheMinimumFreeGigabytes,
        4,
        0,
        1024,
      ),
      includePaths: normalizeIncludePaths(value.includePaths),
      statusRefreshSeconds: clampInt(value.statusRefreshSeconds, 2, 1, 60),
    };
  }

  async function prepareCaptureVoyageDownload(fileName) {
    const api = app.ajrmMarineCaptureApi || globalThis[AJRM_MARINE_CAPTURE_API_REGISTRY];
    if (!api || typeof api.prepareVoyageDownload !== "function") return null;
    try {
      return await api.prepareVoyageDownload(fileName);
    } catch (error) {
      app.error(`[${plugin.id}] Capture portable voyage download failed: ${error.stack || error.message}`);
      return null;
    }
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
        replayWarmupMinutes: clampInt(parsed.replayWarmupMinutes, 7, 0, 1440),
        replayFullBackfill: parsed.replayFullBackfill === true,
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
        replayWarmupMinutes: options.replayWarmupMinutes,
        replayFullBackfill: options.replayFullBackfill,
      }, null, 2)}\n`,
    );
  }

  function onLiveDelta(delta) {
    if (!delta || typeof delta !== "object") return;
    const replayInputKind = classifyReplayInputDelta(delta);
    const replayInput = Boolean(replayInputKind);
    if (
      !replayInput &&
      (delta.$source === plugin.id || delta.source?.label === plugin.id)
    ) {
      return;
    }
    if (handlePowerIntent(delta)) return;
    if (shutdownPending) return;
    if (isPlaybackClockDelta(delta)) return;

    const flushActive =
      recording?.kind === "recomputed-replay" &&
      Number.isFinite(playback.calculationFlushUntilMs) &&
      Date.now() <= playback.calculationFlushUntilMs;
    const resultCaptureActive =
      recording?.kind === "recomputed-replay" &&
      (playback.active || playback.paused || flushActive);
    if (resultCaptureActive) {
      if (replayInput) {
        if (activeReplayInjection) activeReplayInjection.captured = true;
        if (replayInputKind === "delayed") {
          recordDelayedReplayEcho(playback.liveInputIsolation, delta);
        }
        return;
      }
      const isolated = quarantinePhysicalSourceUpdates(
        delta,
        playback.sourcePolicy,
      );
      mergeLiveInputIsolation(playback.liveInputIsolation, isolated.isolation);
      if (!isolated.delta) return;
      const capturedAt = new Date().toISOString();
      const envelope = {
        capturedAt,
        originalCapturedAt: playback.current,
        replayRole: "recomputed-output",
        delta: isolated.delta,
      };
      writeRecordingEnvelope(envelope);
      stats.replayOutputsCaptured += 1;
      extendCalculationFlushAfterOutput();
      return;
    }

    const filtered = filterDelta(delta);
    if (!filtered) {
      stats.filtered += 1;
      return;
    }
    if (playback.active || playback.paused) return;
    if (recording?.kind === "recomputed-replay") return;
    const capturedAt = getDeltaTimestamp(filtered) || new Date().toISOString();
    const envelope = { capturedAt, delta: filtered };
    writeBufferEnvelope(envelope);
    if (recording) {
      writeRecordingEnvelope(envelope);
    }
  }

  function classifyReplayInputDelta(delta) {
    if (activeReplayInjection) {
      if (activeReplayInjection.delta === delta) return "active";
      if (
        activeReplayInjection.fingerprint === replayDeltaFingerprint(delta)
      ) {
        return "active";
      }
      if (replayDeltaMatchesInjection(delta, activeReplayInjection.delta)) {
        return "active";
      }
    }
    const fingerprint = replayDeltaFingerprint(delta);
    pruneRecentReplayInjections();
    const expiresAtMs = recentReplayInjections.get(fingerprint);
    if (Number.isFinite(expiresAtMs) && expiresAtMs >= performance.now()) {
      return "delayed";
    }
    return replayDeltaMatchesRecentEvidence(delta) ? "delayed" : null;
  }

  function replayDeltaFingerprint(delta) {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({
        context: replayEvidenceContext(delta?.context),
        updates: (delta?.updates || []).map((update) => ({
          timestamp: update?.timestamp || null,
          source: update?.$source || update?.source?.label || null,
          values: (update?.values || []).map((entry) => ({
            path: entry?.path || "",
            value: entry?.value,
          })),
        })),
      }))
      .digest("hex");
  }

  function rememberReplayInjection(delta) {
    pruneRecentReplayInjections();
    const configuredMs = Number(
      app.ajrmMarineLoggerTestHooks?.replayEchoWindowMs,
    );
    const windowMs =
      Number.isFinite(configuredMs) && configuredMs >= 0
        ? configuredMs
        : DEFAULT_REPLAY_ECHO_WINDOW_MS;
    const expiresAtMs = performance.now() + windowMs;
    recentReplayInjections.set(replayDeltaFingerprint(delta), expiresAtMs);
    for (const update of delta?.updates || []) {
      const evidence = replayUpdateEvidence(delta, update);
      if (!evidence) continue;
      const candidates = recentReplayUpdateEvidence.get(evidence.key) || [];
      if (!candidates.some((candidate) =>
        replayValueFingerprintsEqual(candidate.values, evidence.values)
      )) {
        candidates.push({ expiresAtMs, values: evidence.values });
      } else {
        for (const candidate of candidates) {
          if (replayValueFingerprintsEqual(candidate.values, evidence.values)) {
            candidate.expiresAtMs = Math.max(candidate.expiresAtMs, expiresAtMs);
          }
        }
      }
      recentReplayUpdateEvidence.set(evidence.key, candidates);
    }
  }

  function pruneRecentReplayInjections() {
    const nowMs = performance.now();
    for (const [fingerprint, expiresAtMs] of recentReplayInjections) {
      if (expiresAtMs < nowMs) recentReplayInjections.delete(fingerprint);
    }
    for (const [key, candidates] of recentReplayUpdateEvidence) {
      const activeCandidates = candidates.filter(
        (candidate) => candidate.expiresAtMs >= nowMs,
      );
      if (activeCandidates.length) {
        recentReplayUpdateEvidence.set(key, activeCandidates);
      } else {
        recentReplayUpdateEvidence.delete(key);
      }
    }
  }

  function replayDeltaMatchesInjection(delta, injectedDelta) {
    const injectedByKey = new Map();
    for (const update of injectedDelta?.updates || []) {
      const evidence = replayUpdateEvidence(injectedDelta, update);
      if (!evidence) continue;
      const candidates = injectedByKey.get(evidence.key) || [];
      candidates.push(evidence.values);
      injectedByKey.set(evidence.key, candidates);
    }
    return replayDeltaMatchesEvidence(delta, (key) => injectedByKey.get(key));
  }

  function replayDeltaMatchesRecentEvidence(delta) {
    pruneRecentReplayInjections();
    return replayDeltaMatchesEvidence(delta, (key) =>
      (recentReplayUpdateEvidence.get(key) || []).map(
        (candidate) => candidate.values,
      )
    );
  }

  function replayDeltaMatchesEvidence(delta, candidatesForKey) {
    const updates = Array.isArray(delta?.updates) ? delta.updates : [];
    if (!updates.length) return false;
    return updates.every((update) => {
      const evidence = replayUpdateEvidence(delta, update);
      if (!evidence) return false;
      const candidates = candidatesForKey(evidence.key) || [];
      return candidates.some((candidateValues) =>
        replayValuesAreSubset(evidence.values, candidateValues)
      );
    });
  }

  function replayUpdateEvidence(delta, update) {
    if (
      !update?.timestamp ||
      !Array.isArray(update.values) ||
      update.values.length === 0
    ) {
      return null;
    }
    const sourceId = sourceIdentityForUpdate(delta, update);
    if (!sourceId) return null;
    const key = crypto
      .createHash("sha256")
      .update(JSON.stringify({
        context: replayEvidenceContext(delta?.context),
        timestamp: update.timestamp,
        source: sourceId,
        pgn: update?.source?.pgn ?? null,
      }))
      .digest("hex");
    return {
      key,
      values: update.values.map(replayValueFingerprint).sort(),
    };
  }

  function replayEvidenceContext(context) {
    const contextId = String(context || "").trim();
    const selfId = String(app.selfId || "")
      .trim()
      .replace(/^vessels\./, "");
    if (
      contextId === "vessels.self" ||
      (selfId &&
        (contextId === selfId || contextId === `vessels.${selfId}`))
    ) {
      return "vessels.self";
    }
    return contextId || null;
  }

  function replayValueFingerprint(entry) {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({
        path: entry?.path || "",
        value: entry?.value,
      }))
      .digest("hex");
  }

  function replayValuesAreSubset(received, injected) {
    const remaining = new Map();
    for (const fingerprint of injected) {
      remaining.set(fingerprint, Number(remaining.get(fingerprint) || 0) + 1);
    }
    for (const fingerprint of received) {
      const count = Number(remaining.get(fingerprint) || 0);
      if (count < 1) return false;
      remaining.set(fingerprint, count - 1);
    }
    return true;
  }

  function replayValueFingerprintsEqual(left, right) {
    return (
      left.length === right.length &&
      left.every((fingerprint, index) => fingerprint === right[index])
    );
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
    syncReplayResultSegment(segment);
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

  async function startReplayResultRecording(metadata = {}) {
    if (!playback.loaded) {
      throw new Error("Load a voyage or recording before starting recomputed replay capture");
    }
    if (playback.mode !== PLAYBACK_MODE_SENSOR_SOURCES) {
      throw new Error("Select Sensor sources only playback before starting recomputed replay capture");
    }
    if (playback.lastError) {
      throw new Error(
        "Reload the voyage before starting a new recomputed capture after a playback failure",
      );
    }
    if (playback.cursor !== playback.startCursor) {
      throw new Error("Restart playback before starting a complete recomputed replay capture");
    }
    if (playback.active || playback.paused) {
      throw new Error("Stop playback at its loaded start before starting recomputed replay capture");
    }
    if (playback.rate !== 1) {
      throw new Error("Select 1x playback before starting recomputed replay capture");
    }
    if (recording) {
      if (recording.kind === "recomputed-replay") return getRecordingSummary();
      throw new Error("Stop the normal capture before starting recomputed replay capture");
    }
    await prepareAllReplaySegments();
    if (!playback.sourcePolicy?.resolvedSensorSourceIds?.length) {
      throw new Error("No recorded physical sensor source identities matched the configured policy");
    }
    const replayResult = {
      schemaVersion: 1,
      kind: "recomputed-replay",
      parentVoyage: String(
        metadata.parentVoyage ||
        playback.voyageFileName ||
        playback.displayFileName ||
        playback.fileName ||
        "",
      ),
      playbackFileName: playback.fileName,
      displayFileName: playback.displayFileName || playback.fileName,
      sourceKind: playback.sourceKind,
      playbackMode: playbackModeContract(playback.mode),
      rate: playback.rate,
      sourcePolicy: playback.sourcePolicy,
      originalFrom: playback.captureFrom,
      originalTo: playback.captureTo,
      originalVoyageStartedAt: playback.voyageStartedAt,
      requestedBy: String(metadata.requestedBy || "ajrm-marine-logger"),
      liveInputIsolationRequired: true,
    };
    playback.filterStats = createFilterStats();
    playback.liveInputIsolation = createLiveInputIsolation();
    recentReplayInjections.clear();
    recentReplayUpdateEvidence.clear();
    resetCalculationFlush();
    const result = await startRecording(0, {
      kind: "recomputed-replay",
      replayResult,
    });
    addEvent(
      "replay-result-capture-started",
      `Recording recomputed result for ${replayResult.parentVoyage || replayResult.displayFileName}`,
    );
    publishPlaybackClock(playback.active || playback.paused);
    return result;
  }

  async function stopReplayResultRecording(reason) {
    if (recording?.kind !== "recomputed-replay") {
      throw new Error("No recomputed replay capture is active");
    }
    const coverage = buildPlaybackCoverage();
    if (
      playback.active ||
      playback.paused ||
      coverage.complete !== true ||
      playback.lastReason !== "end of capture"
    ) {
      throw new Error(
        "Let sensor-only playback reach the end before stopping recomputed replay capture",
      );
    }
    if (!Number.isFinite(playback.calculationFlushUntilMs)) {
      beginCalculationFlush();
    }
    const initialRemainingMs = calculationFlushRemainingMs();
    if (initialRemainingMs > 0) {
      addEvent(
        "replay-calculation-flush",
        `Waiting for ${Math.ceil(initialRemainingMs / 1000)} seconds of calculation quiet time`,
      );
      await waitForCalculationFlush();
    }
    const summary = await stopRecordingAndWait(reason);
    resetCalculationFlush();
    publishPlaybackClock(false);
    return summary;
  }

  async function abortReplayResultRecording(reason) {
    if (recording?.kind !== "recomputed-replay") {
      throw new Error("No recomputed replay capture is active");
    }
    const inputCoverage = buildPlaybackCoverage();
    const abortReason = String(reason || "recomputed replay capture aborted");
    haltPlaybackForReplayAbort(abortReason);
    const summary = await stopRecordingAndWait(abortReason, {
      aborted: true,
      abortReason,
      inputCoverage,
    });
    resetCalculationFlush();
    resetPlaybackToStart(abortReason);
    playback.paused = false;
    publishPlaybackClock(false);
    updateProviderStatus();
    addEvent(
      "replay-result-capture-aborted",
      `${summary.fileName} aborted with ${summary.replayResult?.resultSegments?.segmentsTotal || 0} preserved partial segment(s)`,
    );
    return summary;
  }

  function haltPlaybackForReplayAbort(reason) {
    clearTimeout(playback.timer);
    playback.timer = null;
    playback.active = false;
    playback.paused = false;
    playback.lastReason = reason;
    playback.previousTs = null;
    playback.sourceAnchorMs = null;
    playback.pacingAnchorMs = null;
    playback.lastLinePacingMs = null;
    playbackOperation.invalidate();
  }

  async function stopRecordingAndWait(reason, resultOptions = {}) {
    if (!recording) return null;
    const segment = recording;
    const summary = getRecordingSummary();
    const resultCaptureSession = segment.resultCaptureSession || null;
    if (resultCaptureSession && resultOptions.aborted === true) {
      resultCaptureSession.aborted = true;
      resultCaptureSession.abortReason =
        String(resultOptions.abortReason || reason || "recomputed replay capture aborted");
    }
    recording = null;
    let finalPath = segment.filePath;
    let resultSegments = null;
    if (segment.kind === "recomputed-replay" && resultCaptureSession) {
      await trackReplayResultSegmentFinalization(
        segment,
        "recomputed-replay-closed",
      );
      await Promise.all(resultCaptureSession.finalizations);
      resultCaptureSession.closed = true;
      resultSegments = await validateReplayResultSegments(resultCaptureSession);
      finalPath = segment.resultSegment?.finalPath || segment.filePath;
    } else {
      await endRecordingStream(segment);
      if (options.compressCompletedCaptures) {
        finalPath = await compressRecordingFile(segment.filePath) || segment.filePath;
      }
      await generateRecordingMetadataTracked(finalPath, "capture-closed");
    }
    const replayResult = segment.kind === "recomputed-replay"
      ? replayResultSummary(segment, resultSegments, resultOptions)
      : null;
    const finalSummary = {
      ...summary,
      active: false,
      fileName: path.basename(finalPath),
      lines: resultSegments?.lines ?? summary.lines,
      from: resultSegments?.from ?? summary.from,
      to: resultSegments?.to ?? summary.to,
      bytes: resultSegments?.bytes ?? fileSize(finalPath),
      compressed: isCompressedLogName(finalPath),
      replayResult,
    };
    addEvent("capture-stopped", `${finalSummary.fileName} stopped: ${reason}`);
    updateProviderStatus();
    return finalSummary;
  }

  function createReplayResultCaptureSession() {
    return {
      schemaVersion: 1,
      closed: false,
      aborted: false,
      abortReason: null,
      segments: [],
      finalizations: [],
      errors: [],
    };
  }

  function registerReplayResultSegment(segment, session) {
    if (!segment || !session) return;
    const entry = {
      index: session.segments.length,
      fileName: segment.fileName,
      filePath: segment.filePath,
      startedAt: segment.startedAt,
      from: null,
      to: null,
      lines: 0,
      bytes: 0,
      compressed: false,
      finalized: false,
      available: true,
      omitted: false,
      error: null,
    };
    segment.resultCaptureSession = session;
    segment.resultSegment = entry;
    session.segments.push(entry);
  }

  function syncReplayResultSegment(segment) {
    const entry = segment?.resultSegment;
    if (!entry) return;
    entry.fileName = path.basename(entry.finalPath || segment.filePath);
    entry.from = segment.from || null;
    entry.to = segment.to || null;
    entry.lines = Number(segment.lines || 0);
    entry.bytes = fileSize(entry.finalPath || segment.filePath);
    entry.compressed = isCompressedLogName(entry.finalPath || segment.filePath);
  }

  function trackReplayResultSegmentFinalization(segment, reason) {
    if (!segment?.resultCaptureSession || !segment.resultSegment) {
      return Promise.resolve(null);
    }
    if (segment.resultFinalization) return segment.resultFinalization;
    syncReplayResultSegment(segment);
    const session = segment.resultCaptureSession;
    const finalization = finalizeReplayResultSegment(segment, reason)
      .catch((error) => {
        const message = error?.message || String(error);
        segment.resultSegment.error = message;
        segment.resultSegment.available = false;
        appendReplayResultSessionError(session, segment.resultSegment, message);
        logError("recomputed replay segment finalization failed", error);
        return segment.resultSegment;
      });
    segment.resultFinalization = finalization;
    session.finalizations.push(finalization);
    return finalization;
  }

  async function finalizeReplayResultSegment(segment, reason) {
    const entry = segment.resultSegment;
    await endRecordingStream(segment);
    syncReplayResultSegment(segment);
    if (entry.lines <= 0 || fileSize(segment.filePath) <= 0) {
      entry.omitted = true;
      entry.finalized = true;
      entry.available = true;
      await fs.promises.unlink(segment.filePath).catch(() => {});
      await fs.promises.unlink(recordingMetadataPath(segment.filePath)).catch(() => {});
      return entry;
    }

    let finalPath = segment.filePath;
    if (options.compressCompletedCaptures) {
      try {
        finalPath = await compressRecordingFile(segment.filePath) || segment.filePath;
      } catch (error) {
        logError("recomputed replay segment compression failed; retaining plain segment", error);
      }
    }
    entry.finalPath = finalPath;
    entry.filePath = finalPath;
    entry.fileName = path.basename(finalPath);
    entry.bytes = fileSize(finalPath);
    entry.compressed = isCompressedLogName(finalPath);
    entry.finalized = true;
    entry.available = false;
    try {
      await generateRecordingMetadataTracked(finalPath, reason, { rethrow: true });
      entry.available = entry.bytes > 0;
    } catch (error) {
      entry.error =
        `Replay result segment validation failed for ${entry.fileName}: ${error.message || error}`;
      throw new Error(entry.error, { cause: error });
    }
    return entry;
  }

  async function endRecordingStream(segment) {
    const stream = segment?.stream;
    if (!stream || stream.destroyed || stream.writableEnded) return;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        stream.off("error", onError);
        reject(error);
      };
      stream.once("error", onError);
      stream.end(() => {
        stream.off("error", onError);
        resolve();
      });
    });
  }

  function replayResultSegmentManifestSnapshot(session) {
    const materialized = (session?.segments || [])
      .filter((entry) => !entry.omitted)
      .map((entry) => ({
        index: entry.index,
        fileName: entry.fileName,
        startedAt: entry.startedAt || null,
        from: entry.from || null,
        to: entry.to || null,
        lines: Number(entry.lines || 0),
        bytes: Number(entry.bytes || 0),
        compressed: entry.compressed === true,
        finalized: entry.finalized === true,
        available: entry.available !== false,
        error: entry.error || null,
      }));
    const fileNames = materialized.map((entry) => entry.fileName);
    const uniqueFileNames = new Set(fileNames);
    const aborted = session?.aborted === true;
    const complete = Boolean(
      !aborted &&
      session?.closed === true &&
      materialized.length > 0 &&
      uniqueFileNames.size === materialized.length &&
      materialized.every((entry) =>
        entry.finalized &&
        entry.available &&
        entry.lines > 0 &&
        entry.bytes > 0,
      ),
    );
    return {
      schemaVersion: 1,
      complete,
      incomplete: !complete,
      aborted,
      abortReason: aborted ? session?.abortReason || "recomputed replay capture aborted" : null,
      segmentsTotal: materialized.length,
      segmentsFinalized: materialized.filter((entry) => entry.finalized).length,
      lines: materialized.reduce((total, entry) => total + entry.lines, 0),
      bytes: materialized.reduce((total, entry) => total + entry.bytes, 0),
      from: materialized.reduce(
        (value, entry) => earliestIsoTimestamp(value, entry.from),
        null,
      ),
      to: materialized.reduce(
        (value, entry) => latestIsoTimestamp(value, entry.to),
        null,
      ),
      errors: (session?.errors || []).map((entry) => ({ ...entry })),
      segments: materialized,
    };
  }

  async function validateReplayResultSegments(session) {
    for (const entry of session?.segments || []) {
      if (entry.omitted) continue;
      const filePath = entry.finalPath || entry.filePath;
      const info = await fs.promises.stat(filePath).catch(() => null);
      const expectedBytes = Number(entry.bytes || 0);
      entry.available = Boolean(
        info?.isFile() &&
        info.size > 0 &&
        expectedBytes > 0 &&
        info.size === expectedBytes,
      );
      if (entry.available && isCompressedLogName(filePath)) {
        try {
          await validateGzipReadable(filePath);
        } catch (error) {
          entry.available = false;
          entry.error =
            `Declared replay result segment is not readable gzip: ${entry.fileName}: ${error.message || error}`;
          appendReplayResultSessionError(session, entry, entry.error);
        }
      }
      if (!entry.available && !entry.error) {
        entry.error = `Declared replay result segment is missing or changed: ${entry.fileName}`;
        appendReplayResultSessionError(session, entry, entry.error);
      }
    }
    return replayResultSegmentManifestSnapshot(session);
  }

  function appendReplayResultSessionError(session, entry, error) {
    if (!session || !entry || !error) return;
    const duplicate = session.errors.some((item) =>
      item.index === entry.index &&
      item.fileName === entry.fileName &&
      item.error === error,
    );
    if (!duplicate) {
      session.errors.push({
        index: entry.index,
        fileName: entry.fileName,
        error,
      });
    }
  }

  function beginCalculationFlush() {
    if (recording?.kind !== "recomputed-replay") return;
    const now = Date.now();
    if (!Number.isFinite(playback.calculationFlushStartedAtMs)) {
      playback.calculationFlushStartedAtMs = now;
      playback.calculationFlushMaxUntilMs = now + calculationFlushMaxMs();
    }
    playback.calculationFlushUntilMs = Math.min(
      Number(playback.calculationFlushMaxUntilMs),
      now + calculationFlushQuietMs(),
    );
    scheduleCalculationFlushProjectionRefresh();
  }

  function scheduleCalculationFlushProjectionRefresh() {
    clearTimeout(playback.calculationFlushTimer);
    const remainingMs = calculationFlushRemainingMs();
    if (remainingMs <= 0) {
      playback.calculationFlushTimer = null;
      publishPlaybackClock(false);
      updateProviderStatus();
      return;
    }
    playback.calculationFlushTimer = setTimeout(() => {
      playback.calculationFlushTimer = null;
      if (calculationFlushRemainingMs() > 0) {
        scheduleCalculationFlushProjectionRefresh();
        return;
      }
      publishPlaybackClock(false);
      updateProviderStatus();
    }, remainingMs + 5);
  }

  function extendCalculationFlushAfterOutput() {
    if (!Number.isFinite(playback.calculationFlushStartedAtMs)) return;
    playback.calculationFlushOutputCount += 1;
    beginCalculationFlush();
  }

  async function waitForCalculationFlush() {
    while (calculationFlushRemainingMs() > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, calculationFlushRemainingMs()),
      );
    }
  }

  function calculationFlushRemainingMs() {
    return Math.max(
      0,
      Number(playback.calculationFlushUntilMs || 0) - Date.now(),
    );
  }

  function calculationFlushQuietMs() {
    return positiveTestDuration(
      app.ajrmMarineLoggerTestHooks?.calculationFlushQuietMs,
      REPLAY_CALCULATION_FLUSH_MS,
    );
  }

  function calculationFlushMaxMs() {
    return Math.max(
      calculationFlushQuietMs(),
      positiveTestDuration(
        app.ajrmMarineLoggerTestHooks?.calculationFlushMaxMs,
        REPLAY_CALCULATION_FLUSH_MAX_MS,
      ),
    );
  }

  function resetCalculationFlush() {
    clearTimeout(playback.calculationFlushTimer);
    playback.calculationFlushTimer = null;
    playback.calculationFlushStartedAtMs = null;
    playback.calculationFlushUntilMs = null;
    playback.calculationFlushMaxUntilMs = null;
    playback.calculationFlushOutputCount = 0;
  }

  async function startRecording(backfillMinutes, recordingOptions = {}) {
    if (recording) return getRecordingSummary();
    ensureDirectories();
    const startedAt = new Date();
    const fileName = `capture-${formatFileTime(startedAt)}.jsonl`;
    const filePath = path.join(paths.captures, fileName);
    const resultCaptureSession = recordingOptions.kind === "recomputed-replay"
      ? createReplayResultCaptureSession()
      : null;
    const stream = fs.createWriteStream(filePath, { flags: "a" });
    recording = {
      fileName,
      filePath,
      startedAt: startedAt.toISOString(),
      startedAtMs: startedAt.getTime(),
      backfillMinutes: recordingOptions.kind === "recomputed-replay" ? 0 : backfillMinutes,
      kind: recordingOptions.kind || "live",
      replayResult: recordingOptions.replayResult || null,
      lines: 0,
      backfilled: 0,
      from: null,
      to: null,
      stream,
      backfilling: true,
      pendingEnvelopes: [],
    };
    if (resultCaptureSession) {
      registerReplayResultSegment(recording, resultCaptureSession);
    }

    const cutoffMs = startedAt.getTime() - recording.backfillMinutes * 60 * 1000;
    recording.backfilled = recording.kind === "recomputed-replay"
      ? 0
      : await copyBufferToStream(stream, cutoffMs, recording);
    const pendingEnvelopes = recording.pendingEnvelopes;
    recording.backfilling = false;
    recording.pendingEnvelopes = [];
    for (const envelope of pendingEnvelopes) {
      rotateRecordingIfNeeded(new Date());
      appendRecordingEnvelope(recording, envelope);
    }
    addEvent(
      "capture-started",
      recording.kind === "recomputed-replay"
        ? `Started ${fileName} for recomputed replay with no rolling-buffer backfill`
        : `Started ${fileName} with ${recording.backfilled} buffered deltas`,
    );
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

  function assertNormalCaptureCanStop() {
    if (recording?.kind === "recomputed-replay") {
      throw new Error(
        "Use Stop and build ZIP in AJRM Marine Capture after sensor-only playback reaches the end",
      );
    }
  }

  function rotateRecordingIfNeeded(now) {
    if (!recording) return;
    const elapsedMs = now.getTime() - recording.startedAtMs;
    if (elapsedMs < captureSegmentDurationMs()) return;

    const previous = recording;
    if (previous.kind === "recomputed-replay") {
      trackReplayResultSegmentFinalization(previous, "capture-rotated");
    } else {
      finishRecordingStream(previous, true);
    }

    const fileName = `capture-${formatFileTime(now)}.jsonl`;
    const filePath = path.join(paths.captures, fileName);
    recording = {
      fileName,
      filePath,
      startedAt: now.toISOString(),
      startedAtMs: now.getTime(),
      backfillMinutes: 0,
      kind: previous.kind || "live",
      replayResult: previous.replayResult || null,
      lines: 0,
      backfilled: 0,
      from: null,
      to: null,
      stream: fs.createWriteStream(filePath, { flags: "a" }),
      backfilling: false,
      pendingEnvelopes: [],
    };
    if (previous.resultCaptureSession) {
      registerReplayResultSegment(recording, previous.resultCaptureSession);
    }
    addEvent("capture-rotated", `${previous.fileName} closed; ${fileName} started`);
    updateProviderStatus();
  }

  function captureSegmentDurationMs() {
    return positiveTestDuration(
      app.ajrmMarineLoggerTestHooks?.captureSegmentMs,
      options.captureSegmentMinutes * 60 * 1000,
    );
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

  async function compressRecordingFile(filePath, recoveryCandidate = null) {
    if (!filePath.endsWith(".jsonl")) return null;
    if (!startupRecoveryCandidateIsCurrent(recoveryCandidate)) return null;
    if (recoveryCandidate && recording?.filePath === filePath) return null;
    const compressedPath = `${filePath}.gz`;
    const statsInfo = await fs.promises.stat(filePath).catch(() => null);
    if (!statsInfo?.isFile() || statsInfo.size === 0) return null;
    if (
      recoveryCandidate &&
      !startupRecoveryFileMatches(statsInfo, recoveryCandidate.source)
    ) {
      return null;
    }
    const compressedStats = await fs.promises.stat(compressedPath).catch(() => null);
    if (
      recoveryCandidate?.compressed &&
      !compressedStats?.isFile()
    ) {
      return null;
    }
    if (compressedStats?.isFile()) {
      if (
        recoveryCandidate &&
        (
          !recoveryCandidate.compressed ||
          !startupRecoveryFileMatches(
            compressedStats,
            recoveryCandidate.compressed,
          )
        )
      ) {
        return null;
      }
      try {
        await validateGzipReadable(compressedPath);
      } catch (error) {
        if (
          recoveryCandidate &&
          (
            !startupRecoveryCandidateIsCurrent(recoveryCandidate) ||
            recording?.filePath === filePath ||
            !await startupRecoveryCandidateStillMatches(
              filePath,
              recoveryCandidate.source,
              recoveryCandidate.recoveryGeneration,
            ) ||
            !await startupRecoveryCandidateStillMatches(
              compressedPath,
              recoveryCandidate.compressed,
              recoveryCandidate.recoveryGeneration,
            )
          )
        ) {
          return null;
        }
        const quarantinedPath = await quarantineInvalidCompressedFile(
          compressedPath,
          recoveryCandidate,
        );
        if (!quarantinedPath) return null;
        clearRecordingMetadataFailure(compressedPath);
        throw new Error(
          `Existing compressed capture ${path.basename(compressedPath)} is invalid (${error.message || error}); moved it to ${path.basename(quarantinedPath)} and preserved ${path.basename(filePath)}`,
          { cause: error },
        );
      }
      const contentsMatch = await plainAndGzipContentsMatch(
        filePath,
        compressedPath,
      );
      if (!contentsMatch) {
        addEvent(
          "capture-compression-conflict",
          `Kept ${path.basename(filePath)} because existing ${path.basename(compressedPath)} contains different data`,
        );
        return null;
      }
      if (
        recoveryCandidate &&
        (
          !startupRecoveryCandidateIsCurrent(recoveryCandidate) ||
          recording?.filePath === filePath ||
          !await startupRecoveryCandidateStillMatches(
            filePath,
            recoveryCandidate.source,
            recoveryCandidate.recoveryGeneration,
          ) ||
          !await startupRecoveryCandidateStillMatches(
            compressedPath,
            recoveryCandidate.compressed,
            recoveryCandidate.recoveryGeneration,
          )
        )
      ) {
        return null;
      }
      if (!startupRecoveryCandidateIsCurrent(recoveryCandidate)) return null;
      await fs.promises.unlink(filePath).catch(() => {});
      await removeCompressedSourceMetadata(filePath, recoveryCandidate);
      clearRecordingMetadataFailure(filePath);
      return compressedPath;
    }

    const tempPath = `${compressedPath}.tmp`;
    if (!startupRecoveryCandidateIsCurrent(recoveryCandidate)) return null;
    let ownsTemporaryPath = false;
    const temporaryStream = fs.createWriteStream(tempPath, { flags: "wx" });
    temporaryStream.once("open", () => {
      ownsTemporaryPath = true;
    });
    try {
      await pipeline(
        fs.createReadStream(filePath),
        zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED }),
        temporaryStream,
      );
      if (typeof app.ajrmMarineLoggerTestHooks?.afterCompressTemporaryFile === "function") {
        await app.ajrmMarineLoggerTestHooks.afterCompressTemporaryFile({
          sourcePath: filePath,
          temporaryPath: tempPath,
          compressedPath,
        });
      }
      await validateGzipReadable(tempPath);
      const contentsMatch = recoveryCandidate
        ? await plainAndGzipContentsMatch(filePath, tempPath)
        : true;
      if (
        (
          !contentsMatch ||
          (
            recoveryCandidate &&
            (
              !startupRecoveryCandidateIsCurrent(recoveryCandidate) ||
              recording?.filePath === filePath ||
              !await startupRecoveryCandidateStillMatches(
                filePath,
                recoveryCandidate.source,
                recoveryCandidate.recoveryGeneration,
              )
            )
          )
        )
      ) {
        if (ownsTemporaryPath) {
          await fs.promises.unlink(tempPath).catch(() => {});
        }
        return null;
      }
    } catch (error) {
      if (ownsTemporaryPath) {
        await fs.promises.unlink(tempPath).catch(() => {});
      }
      throw error;
    }
    try {
      await fs.promises.link(tempPath, compressedPath);
    } catch (error) {
      if (ownsTemporaryPath) {
        await fs.promises.unlink(tempPath).catch(() => {});
      }
      if (error?.code === "EEXIST") return null;
      throw error;
    }
    let publishedContentsMatch = false;
    try {
      publishedContentsMatch = await plainAndGzipContentsMatch(
        filePath,
        compressedPath,
      );
    } catch (error) {
      await fs.promises.unlink(compressedPath).catch(() => {});
      await fs.promises.unlink(tempPath).catch(() => {});
      throw error;
    }
    if (!publishedContentsMatch) {
      await fs.promises.unlink(compressedPath).catch(() => {});
      await fs.promises.unlink(tempPath).catch(() => {});
      return null;
    }
    if (
      recoveryCandidate &&
      (
        !startupRecoveryCandidateIsCurrent(recoveryCandidate) ||
        recording?.filePath === filePath ||
        !await startupRecoveryCandidateStillMatches(
          filePath,
          recoveryCandidate.source,
          recoveryCandidate.recoveryGeneration,
        )
      )
    ) {
      await fs.promises.unlink(compressedPath).catch(() => {});
      await fs.promises.unlink(tempPath).catch(() => {});
      return null;
    }
    await fs.promises.unlink(tempPath).catch(() => {});
    if (
      recoveryCandidate &&
      (
        !startupRecoveryCandidateIsCurrent(recoveryCandidate) ||
        recording?.filePath === filePath ||
        !await startupRecoveryCandidateStillMatches(
          filePath,
          recoveryCandidate.source,
          recoveryCandidate.recoveryGeneration,
        )
      )
    ) {
      await fs.promises.unlink(compressedPath).catch(() => {});
      return null;
    }
    await fs.promises.unlink(filePath).catch(() => {});
    await removeCompressedSourceMetadata(filePath, recoveryCandidate);
    clearRecordingMetadataFailure(filePath);
    clearRecordingMetadataFailure(compressedPath);
    stats.compressed += 1;
    addEvent("capture-compressed", `${path.basename(filePath)} compressed`);
    return compressedPath;
  }

  async function removeCompressedSourceMetadata(filePath, recoveryCandidate) {
    const metadataPath = recordingMetadataPath(filePath);
    if (!recoveryCandidate) {
      await fs.promises.unlink(metadataPath).catch(() => {});
      return;
    }
    if (recoveryCandidate.sourceMetadata) {
      await unlinkUnchangedStartupFile(
        metadataPath,
        recoveryCandidate.sourceMetadata,
        recoveryCandidate.recoveryGeneration,
      );
    }
  }

  async function quarantineInvalidCompressedFile(
    filePath,
    recoveryCandidate = null,
  ) {
    if (!startupRecoveryCandidateIsCurrent(recoveryCandidate)) return null;
    let quarantinePath = `${filePath}.corrupt`;
    let suffix = 2;
    while (await fileExists(quarantinePath)) {
      quarantinePath = `${filePath}.corrupt-${suffix}`;
      suffix += 1;
    }
    if (
      recoveryCandidate &&
      !await startupRecoveryCandidateStillMatches(
        filePath,
        recoveryCandidate.compressed,
        recoveryCandidate.recoveryGeneration,
      )
    ) {
      return null;
    }
    await fs.promises.rename(filePath, quarantinePath);
    const metadataPath = recordingMetadataPath(filePath);
    const quarantineMetadataPath = recordingMetadataPath(quarantinePath);
    if (!recoveryCandidate) {
      await fs.promises.rename(
        metadataPath,
        quarantineMetadataPath,
      ).catch(() => {});
    } else if (
      recoveryCandidate.compressedMetadata &&
      await startupRecoveryCandidateStillMatches(
        metadataPath,
        recoveryCandidate.compressedMetadata,
        recoveryCandidate.recoveryGeneration,
      )
    ) {
      await fs.promises.rename(
        metadataPath,
        quarantineMetadataPath,
      ).catch(() => {});
    }
    addEvent(
      "capture-quarantined",
      `Moved unreadable ${path.basename(filePath)} to ${path.basename(quarantinePath)}`,
    );
    return quarantinePath;
  }

  async function recoverStaleCaptureFiles(
    snapshot,
    recoveryGeneration,
    previousRecovery,
  ) {
    const beforeCleanup =
      app.ajrmMarineLoggerTestHooks?.beforeStartupRecoveryCleanup;
    try {
      await Promise.resolve(previousRecovery).catch(() => {});
      if (!startupRecoveryIsCurrent(recoveryGeneration)) return;
      if (typeof beforeCleanup === "function") {
        await beforeCleanup(snapshot);
      }
      if (!startupRecoveryIsCurrent(recoveryGeneration)) return;
      await Promise.all([
        removeOrphanCompressionTemps(
          paths.captures,
          snapshot.captures,
          recoveryGeneration,
        ),
        removeOrphanMetadataTemps(
          paths.captures,
          snapshot.captures,
          recoveryGeneration,
        ),
        removeOrphanMetadataTemps(
          paths.clips,
          snapshot.clips,
          recoveryGeneration,
        ),
        removeEmptyStaleCaptureFiles(
          paths.captures,
          snapshot.captures,
          recoveryGeneration,
        ),
      ]);
      if (
        startupRecoveryIsCurrent(recoveryGeneration) &&
        options.compressCompletedCaptures
      ) {
        await compressStaleCaptureFiles(
          snapshot.captures,
          recoveryGeneration,
        );
      }
    } catch (error) {
      if (startupRecoveryIsCurrent(recoveryGeneration)) {
        logError("startup capture recovery failed", error);
      }
    } finally {
      const afterCleanup =
        app.ajrmMarineLoggerTestHooks?.afterStartupRecoveryCleanup;
      if (typeof afterCleanup === "function") {
        await Promise.resolve(afterCleanup({
          snapshot,
          recoveryGeneration,
          cancelled: !startupRecoveryIsCurrent(recoveryGeneration),
        })).catch(() => {});
      }
    }
  }

  async function removeOrphanCompressionTemps(
    directory,
    snapshot,
    recoveryGeneration,
  ) {
    const candidates = snapshot.filter(
      (entry) => entry.name.endsWith(".jsonl.gz.tmp"),
    );
    const removed = await removeUnchangedStartupFiles(
      directory,
      candidates,
      recoveryGeneration,
    );
    if (removed) {
      addEvent("startup-cleanup", `Removed ${removed} incomplete capture compression file${removed === 1 ? "" : "s"}`);
    }
  }

  async function removeOrphanMetadataTemps(
    directory,
    snapshot,
    recoveryGeneration,
  ) {
    const candidates = snapshot.filter(
      (entry) => entry.name.endsWith(".meta.json.tmp"),
    );
    const removed = await removeUnchangedStartupFiles(
      directory,
      candidates,
      recoveryGeneration,
    );
    if (removed) {
      addEvent("startup-cleanup", `Removed ${removed} incomplete metadata file${removed === 1 ? "" : "s"}`);
    }
  }

  async function removeEmptyStaleCaptureFiles(
    directory,
    snapshot,
    recoveryGeneration,
  ) {
    const snapshotByName = new Map(
      snapshot.map((entry) => [entry.name, entry]),
    );
    const emptyFiles = snapshot.filter(
      (file) =>
        file.name.endsWith(".jsonl") &&
        file.name !== recording?.fileName &&
        file.size === 0,
    );
    let removed = 0;
    for (const file of emptyFiles) {
      if (!startupRecoveryIsCurrent(recoveryGeneration)) break;
      if (file.name === recording?.fileName) continue;
      const filePath = path.join(directory, file.name);
      if (!await unlinkUnchangedStartupFile(
        filePath,
        file,
        recoveryGeneration,
      )) {
        continue;
      }
      const metadataPath = recordingMetadataPath(filePath);
      const metadataSnapshot = snapshotByName.get(
        path.basename(metadataPath),
      );
      if (metadataSnapshot) {
        await unlinkUnchangedStartupFile(
          metadataPath,
          metadataSnapshot,
          recoveryGeneration,
        );
      }
      removed += 1;
    }
    if (removed) {
      addEvent("startup-cleanup", `Removed ${removed} empty stale capture log${removed === 1 ? "" : "s"}`);
    }
  }

  async function compressStaleCaptureFiles(snapshot, recoveryGeneration) {
    const snapshotByName = new Map(
      snapshot.map((entry) => [entry.name, entry]),
    );
    const results = await Promise.all(
      snapshot
        .filter((file) => file.name !== recording?.fileName && file.size > 0)
        .filter((file) => file.name.endsWith(".jsonl"))
        .map((file) => compressRecordingFile(
          path.join(paths.captures, file.name),
          {
            recoveryGeneration,
            source: file,
            compressed: snapshotByName.get(`${file.name}.gz`) || null,
            sourceMetadata:
              snapshotByName.get(`${file.name}.meta.json`) || null,
            compressedMetadata:
              snapshotByName.get(`${file.name}.gz.meta.json`) || null,
          },
        )),
    );
    if (!startupRecoveryIsCurrent(recoveryGeneration)) return;
    const compressed = results.filter(Boolean).length;
    if (compressed) addEvent("startup-compression", `Compressed ${compressed} stale captures`);
    for (const compressedPath of results.filter(Boolean)) {
      queueRecordingMetadata(compressedPath, "startup-compression");
    }
  }

  function snapshotStartupRecoveryFiles() {
    return {
      captures: snapshotDirectoryFiles(
        paths.captures,
        (name) =>
          name.endsWith(".jsonl") ||
          name.endsWith(".jsonl.gz") ||
          name.endsWith(".jsonl.gz.tmp") ||
          name.endsWith(".meta.json") ||
          name.endsWith(".meta.json.tmp"),
      ),
      clips: snapshotDirectoryFiles(
        paths.clips,
        (name) => name.endsWith(".meta.json.tmp"),
      ),
    };
  }

  function snapshotDirectoryFiles(directory, includeName) {
    const entries = [];
    const names = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of names) {
      if (
        !entry.isFile() ||
        (typeof includeName === "function" && !includeName(entry.name))
      ) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      try {
        const statsInfo = fs.statSync(filePath);
        entries.push(startupRecoveryFileSnapshot(entry.name, statsInfo));
      } catch {
        // A concurrently removed file is not a startup recovery candidate.
      }
    }
    return entries;
  }

  function startupRecoveryFileSnapshot(name, statsInfo) {
    const identityAvailable =
      Number.isSafeInteger(statsInfo.dev) &&
      statsInfo.dev >= 0 &&
      Number.isSafeInteger(statsInfo.ino) &&
      statsInfo.ino > 0;
    return {
      name,
      identityAvailable,
      dev: statsInfo.dev,
      ino: statsInfo.ino,
      size: statsInfo.size,
      mtimeMs: statsInfo.mtimeMs,
      ctimeMs: statsInfo.ctimeMs,
    };
  }

  function startupRecoveryFileMatches(statsInfo, snapshot) {
    if (!statsInfo?.isFile() || !snapshot) return false;
    const currentIdentityAvailable =
      Number.isSafeInteger(statsInfo.dev) &&
      statsInfo.dev >= 0 &&
      Number.isSafeInteger(statsInfo.ino) &&
      statsInfo.ino > 0;
    return (
      snapshot.identityAvailable === true &&
      currentIdentityAvailable &&
      statsInfo.dev === snapshot.dev &&
      statsInfo.ino === snapshot.ino &&
      statsInfo.size === snapshot.size &&
      statsInfo.mtimeMs === snapshot.mtimeMs &&
      statsInfo.ctimeMs === snapshot.ctimeMs
    );
  }

  function startupRecoveryIsCurrent(recoveryGeneration) {
    return (
      Number.isSafeInteger(recoveryGeneration) &&
      recoveryGeneration === startupRecoveryGeneration
    );
  }

  function startupRecoveryCandidateIsCurrent(recoveryCandidate) {
    return (
      !recoveryCandidate ||
      startupRecoveryIsCurrent(recoveryCandidate.recoveryGeneration)
    );
  }

  async function startupRecoveryCandidateStillMatches(
    filePath,
    snapshot,
    recoveryGeneration,
  ) {
    if (!startupRecoveryIsCurrent(recoveryGeneration)) return false;
    const statsInfo = await fs.promises.stat(filePath).catch(() => null);
    return (
      startupRecoveryIsCurrent(recoveryGeneration) &&
      startupRecoveryFileMatches(statsInfo, snapshot)
    );
  }

  async function unlinkUnchangedStartupFile(
    filePath,
    snapshot,
    recoveryGeneration,
  ) {
    if (!await startupRecoveryCandidateStillMatches(
      filePath,
      snapshot,
      recoveryGeneration,
    )) {
      return false;
    }
    if (!startupRecoveryIsCurrent(recoveryGeneration)) return false;
    return fs.promises.unlink(filePath)
      .then(() => true)
      .catch(() => false);
  }

  async function removeUnchangedStartupFiles(
    directory,
    candidates,
    recoveryGeneration,
  ) {
    const results = await Promise.all(
      candidates.map((entry) =>
        unlinkUnchangedStartupFile(
          path.join(directory, entry.name),
          entry,
          recoveryGeneration,
        )),
    );
    return results.filter(Boolean).length;
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

  async function loadPlayback(fileName, kind, playbackOptions = {}) {
    if (replayCacheMaintenancePromise) {
      await replayCacheMaintenancePromise.catch(() => {});
    }
    replayCacheLoadInProgress = true;
    try {
      stopPlayback("loading");
      const normalizedKind = kind ? normalizeRecordingKind(kind) : null;
      if (normalizedKind === "voyages") {
        const preparedVoyage = await prepareVoyagePlayback(fileName, {
          includeFullBackfill:
            playbackOptions.includeFullBackfill === true || options.replayFullBackfill === true,
        });
        return loadPlaybackFile({
          fileName: preparedVoyage.firstSegment.name,
          filePath: preparedVoyage.firstSegment.filePath,
          sourceDirectory: preparedVoyage.firstSegment.directory,
          sourceKind: "voyages",
          voyageFileName: fileName,
          displayFileName: `${fileName} / ${preparedVoyage.firstSegment.name}`,
          initialCapturedAt: preparedVoyage.initialCapturedAt,
          voyageStartedAt: preparedVoyage.voyageStartedAt,
          warmupStartedAt: preparedVoyage.warmupStartedAt,
          includeFullBackfill: preparedVoyage.includeFullBackfill,
          mode: playbackOptions.mode,
          sensorSourceIds: playbackOptions.sensorSourceIds,
          sensorSourcePrefixes: playbackOptions.sensorSourcePrefixes,
          initialSourceCatalog: preparedVoyage.sourceCatalog,
          preparedSegments: preparedVoyage.segments,
          preparedComplete: true,
        });
      }
      const filePath = await resolveCaptureOrClip(fileName, normalizedKind);
      return loadPlaybackFile({
        fileName,
        filePath,
        sourceDirectory: path.dirname(filePath),
        sourceKind: normalizedKind || recordingKindForPath(filePath),
        displayFileName: fileName,
        mode: playbackOptions.mode,
        sensorSourceIds: playbackOptions.sensorSourceIds,
        sensorSourcePrefixes: playbackOptions.sensorSourcePrefixes,
      });
    } finally {
      replayCacheLoadInProgress = false;
    }
  }

  function startPlaybackLoadJob(fileName, kind, playbackOptions = {}) {
    if (playbackLoadJob?.state === "loading") {
      throw new Error(`Already loading ${playbackLoadJob.fileName}`);
    }
    playbackLoadJob = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      state: "loading",
      fileName,
      kind: normalizeRecordingKind(kind || "logs"),
      mode: normalizePlaybackMode(playbackOptions.mode),
      sensorSourceIds: normalizeSensorSourceIds(playbackOptions.sensorSourceIds),
      sensorSourcePrefixes: normalizeSensorSourcePrefixes(
        playbackOptions.sensorSourcePrefixes,
      ),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      playback: null,
    };
    loadPlayback(fileName, kind, playbackOptions)
      .then((result) => {
        if (!playbackLoadJob) return;
        playbackLoadJob.state = "complete";
        playbackLoadJob.finishedAt = new Date().toISOString();
        playbackLoadJob.playback = result;
      })
      .catch((error) => {
        if (!playbackLoadJob) return;
        playbackLoadJob.state = "error";
        playbackLoadJob.finishedAt = new Date().toISOString();
        playbackLoadJob.error = error.message || String(error);
        logError("playback load failed", error);
      });
    return playbackLoadJobSummary();
  }

  function playbackLoadJobSummary() {
    if (!playbackLoadJob) return { state: "idle" };
    return {
      id: playbackLoadJob.id,
      state: playbackLoadJob.state,
      fileName: playbackLoadJob.fileName,
      kind: playbackLoadJob.kind,
      startedAt: playbackLoadJob.startedAt,
      finishedAt: playbackLoadJob.finishedAt,
      error: playbackLoadJob.error,
      playback: playbackLoadJob.playback,
    };
  }

  async function loadPlaybackFile({
    fileName,
    filePath,
    sourceDirectory,
    sourceKind,
    voyageFileName,
    displayFileName,
    initialCapturedAt,
    voyageStartedAt,
    warmupStartedAt,
    includeFullBackfill = false,
    mode,
    sensorSourceIds,
    sensorSourcePrefixes,
    initialSourceCatalog,
    preparedSegments,
    preparedComplete = false,
  }) {
    const suppliedSegments = Array.isArray(preparedSegments)
      ? preparedSegments
      : [];
    const prepared = suppliedSegments.length
      ? suppliedSegments
      : [await preparePlaybackSegment({
          name: fileName,
          filePath,
          directory: sourceDirectory,
        })];
    indexPlaybackSegments(prepared);
    const initialSegmentIndex = Math.max(
      0,
      prepared.findIndex((segment) =>
        segment.filePath === filePath || segment.name === fileName),
    );
    const initialSegment = prepared[initialSegmentIndex];
    const sourceCatalog = suppliedSegments.length
      ? mergePreparedSegmentCatalogs(prepared)
      : mergeSourceCatalog(
          initialSourceCatalog,
          mergePreparedSegmentCatalogs(prepared),
        );
    const sourcePolicy = createSourcePolicy(
      mode,
      { sensorSourceIds, sensorSourcePrefixes },
      sourceCatalog,
    );
    playback = {
      ...createPlaybackState(),
      fileName: initialSegment.name,
      filePath: initialSegment.filePath,
      sourceDirectory,
      sourceKind,
      voyageFileName: voyageFileName || null,
      displayFileName: displayFileName || fileName,
      loaded: true,
      totalLines: totalPreparedLines(prepared),
      from: initialSegment.from,
      to: prepared[prepared.length - 1]?.to || initialSegment.to,
      current: initialSegment.from,
      cursor: initialSegment.baseCursor,
      startCursor: initialSegment.baseCursor,
      startCapturedAt: initialSegment.from,
      captureFrom: prepared[0]?.from || initialSegment.from,
      captureTo: prepared[prepared.length - 1]?.to || initialSegment.to,
      voyageStartedAt: voyageStartedAt || null,
      warmupStartedAt: warmupStartedAt || null,
      includeFullBackfill: includeFullBackfill === true,
      mode: sourcePolicy.mode,
      sourcePolicy,
      sourceCatalog,
      filterStats: createFilterStats(),
      offsets: initialSegment.offsets,
      times: initialSegment.times,
      segments: prepared,
      segmentIndex: initialSegmentIndex,
      segmentCursor: 0,
      startSegmentIndex: initialSegmentIndex,
      startSegmentCursor: 0,
      preparedComplete: preparedComplete === true,
    };
    if (initialCapturedAt) {
      const position = findLineAtOrAfter(Date.parse(initialCapturedAt));
      activatePlaybackSegment(position.segmentIndex, position.segmentCursor);
      playback.cursor = position.cursor;
      playback.current = position.capturedAt || initialSegment.from;
      playback.from = playback.current;
      playback.startCursor = playback.cursor;
      playback.startCapturedAt = playback.current;
      playback.startSegmentIndex = position.segmentIndex;
      playback.startSegmentCursor = position.segmentCursor;
    }
    addEvent("playback-loaded", `Loaded ${playback.displayFileName}`);
    return getPlaybackSummary();
  }

  async function preparePlaybackSegment({
    name,
    filePath,
    directory,
    metadata,
  }) {
    const playbackFilePath = isCompressedLogName(filePath)
      ? await materializeCompressedPlaybackFile(filePath)
      : filePath;
    const statsInfo = await fs.promises.stat(playbackFilePath).catch(() => null);
    const cachedReplayIndex =
      !metadata && statsInfo?.isFile() && isReplayCachePath(playbackFilePath)
        ? await readReplayIndexFile(playbackFilePath, statsInfo)
        : null;
    if (typeof app.ajrmMarineLoggerTestHooks?.beforePreparePlaybackSegment === "function") {
      await app.ajrmMarineLoggerTestHooks.beforePreparePlaybackSegment({
        name: name || path.basename(playbackFilePath),
        filePath: playbackFilePath,
        replayIndexCacheHit: Boolean(cachedReplayIndex),
      });
    }
    const segmentMetadata =
      metadata ||
      cachedReplayIndex ||
      await scanFile(
        playbackFilePath,
        Infinity,
        true,
        true,
      );
    if (statsInfo?.isFile()) {
      await writeRecordingMetadataFile(playbackFilePath, statsInfo, segmentMetadata);
      if (
        !metadata &&
        !cachedReplayIndex &&
        isReplayCachePath(playbackFilePath)
      ) {
        await writeReplayIndexFile(
          playbackFilePath,
          statsInfo,
          segmentMetadata,
        );
      }
    }
    return {
      name: name || path.basename(playbackFilePath),
      filePath: playbackFilePath,
      directory: directory || path.dirname(playbackFilePath),
      lines: Number(segmentMetadata.lines || 0),
      from: segmentMetadata.from || null,
      to: segmentMetadata.to || null,
      offsets: Array.isArray(segmentMetadata.offsets)
        ? segmentMetadata.offsets
        : [],
      times: Array.isArray(segmentMetadata.times)
        ? segmentMetadata.times
        : [],
      sourceCatalog: segmentMetadata.sourceCatalog || {},
      baseCursor: 0,
    };
  }

  function isReplayCachePath(filePath) {
    const relative = path.relative(paths.voyageReplay, filePath);
    return Boolean(
      relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    );
  }

  function replayIndexPath(filePath) {
    return `${filePath}.replay-index.json`;
  }

  async function readReplayIndexFile(filePath, statsInfo) {
    try {
      const indexPath = replayIndexPath(filePath);
      const parsed = JSON.parse(await fs.promises.readFile(indexPath, "utf8"));
      if (parsed?.version !== REPLAY_INDEX_VERSION) return null;
      if (parsed.fileName !== path.basename(filePath)) return null;
      if (Number(parsed.bytes) !== Number(statsInfo.size)) return null;
      if (Math.abs(Number(parsed.mtimeMs) - Number(statsInfo.mtimeMs)) > 1) {
        return null;
      }
      if (!Number.isFinite(parsed.lines) || parsed.lines < 0) return null;
      if (!Array.isArray(parsed.offsets) || !Array.isArray(parsed.times)) {
        return null;
      }
      if (
        parsed.offsets.length !== parsed.lines ||
        parsed.times.length !== parsed.lines
      ) {
        return null;
      }
      await touchPath(indexPath);
      return {
        lines: parsed.lines,
        from: parsed.from || null,
        to: parsed.to || null,
        offsets: parsed.offsets,
        times: parsed.times,
        sourceCatalog:
          parsed.sourceCatalog && typeof parsed.sourceCatalog === "object"
            ? parsed.sourceCatalog
            : {},
      };
    } catch (_error) {
      return null;
    }
  }

  async function writeReplayIndexFile(filePath, statsInfo, metadata) {
    const indexPath = replayIndexPath(filePath);
    const temporaryPath =
      `${indexPath}.${process.pid}.${Date.now()}.tmp`;
    const payload = {
      version: REPLAY_INDEX_VERSION,
      fileName: path.basename(filePath),
      bytes: statsInfo.size,
      mtimeMs: statsInfo.mtimeMs,
      lines: Number(metadata.lines || 0),
      from: metadata.from || null,
      to: metadata.to || null,
      offsets: Array.isArray(metadata.offsets) ? metadata.offsets : [],
      times: Array.isArray(metadata.times) ? metadata.times : [],
      sourceCatalog: metadata.sourceCatalog || {},
      generatedAt: new Date().toISOString(),
    };
    try {
      await fs.promises.writeFile(
        temporaryPath,
        `${JSON.stringify(payload)}\n`,
      );
      await fs.promises.rename(temporaryPath, indexPath);
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
  }

  async function touchPath(filePath) {
    const now = new Date();
    await fs.promises.utimes(filePath, now, now).catch(() => {});
  }

  function indexPlaybackSegments(segments) {
    let baseCursor = 0;
    for (const segment of segments) {
      segment.baseCursor = baseCursor;
      baseCursor += Number(segment.lines || 0);
    }
    return baseCursor;
  }

  function totalPreparedLines(segments = playback.segments) {
    if (!Array.isArray(segments) || !segments.length) return 0;
    const last = segments[segments.length - 1];
    return Number(last.baseCursor || 0) + Number(last.lines || 0);
  }

  function mergePreparedSegmentCatalogs(segments) {
    let sourceCatalog = {};
    for (const segment of segments || []) {
      sourceCatalog = mergeSourceCatalog(sourceCatalog, segment.sourceCatalog);
    }
    return sourceCatalog;
  }

  function activatePlaybackSegment(segmentIndex, segmentCursor = 0) {
    const segment = playback.segments?.[segmentIndex];
    if (!segment) return false;
    playback.segmentIndex = segmentIndex;
    playback.segmentCursor = segmentCursor;
    playback.fileName = segment.name;
    playback.filePath = segment.filePath;
    playback.offsets = segment.offsets;
    playback.times = segment.times;
    playback.current = Number.isFinite(segment.times?.[segmentCursor])
      ? new Date(segment.times[segmentCursor]).toISOString()
      : segment.from;
    playback.displayFileName = playback.voyageFileName
      ? `${playback.voyageFileName} / ${segment.name}`
      : segment.name;
    return true;
  }

  async function prepareAllReplaySegments() {
    if (playback.preparedComplete) return;
    const prepared = playback.segments || [];
    const preparedNames = new Set(prepared.map((segment) => segment.name));
    let current = prepared[prepared.length - 1];
    while (current && playback.sourceDirectory) {
      const nextFile = await nextRecordingFileAfter(
        playback.sourceDirectory,
        {
          fileName: current.name,
          to: current.to,
          current: current.to,
        },
        preparedNames,
      );
      if (!nextFile) break;
      const preparedSegment = await preparePlaybackSegment({
        name: nextFile.name,
        filePath: path.join(playback.sourceDirectory, nextFile.name),
        directory: playback.sourceDirectory,
      });
      prepared.push(preparedSegment);
      preparedNames.add(preparedSegment.name);
      current = preparedSegment;
    }
    indexPlaybackSegments(prepared);
    playback.totalLines = totalPreparedLines(prepared);
    playback.captureFrom = prepared[0]?.from || playback.captureFrom;
    playback.captureTo = prepared[prepared.length - 1]?.to || playback.captureTo;
    playback.to = playback.captureTo;
    playback.sourceCatalog = mergePreparedSegmentCatalogs(prepared);
    playback.sourcePolicy = createSourcePolicy(
      playback.sourcePolicy.mode,
      {
        sensorSourceIds: playback.sourcePolicy.explicitSensorSourceIds,
        sensorSourcePrefixes: playback.sourcePolicy.sensorSourcePrefixes,
      },
      playback.sourceCatalog,
    );
    playback.preparedComplete = true;
  }

  async function materializeCompressedPlaybackFile(compressedPath) {
    const statsInfo = await fs.promises.stat(compressedPath).catch(() => null);
    if (!statsInfo?.isFile()) return compressedPath;
    const cacheDirectory = path.join(paths.voyageReplay, "compressed-captures");
    await fs.promises.mkdir(cacheDirectory, { recursive: true });
    const baseName = safeReplayDirectoryName(path.basename(compressedPath).replace(/\.gz$/i, ""));
    const cacheName = `${baseName}.${statsInfo.size}.${Math.round(statsInfo.mtimeMs)}.jsonl`;
    const cachePath = path.join(cacheDirectory, cacheName);
    const protectedPaths = activeReplayCacheProtectedPaths([cachePath]);
    await enforceReplayCacheLimits(protectedPaths);
    const existing = await fs.promises.stat(cachePath).catch(() => null);
    if (existing?.isFile() && existing.size > 0) {
      await touchPath(cachePath);
      await touchPath(replayIndexPath(cachePath));
      return cachePath;
    }

    const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(
        fs.createReadStream(compressedPath),
        zlib.createGunzip(),
        fs.createWriteStream(temporaryPath),
      );
      await fs.promises.rename(temporaryPath, cachePath);
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
    await enforceReplayCacheLimits(
      activeReplayCacheProtectedPaths([cachePath]),
    );
    return cachePath;
  }

  function activeReplayCacheProtectedPaths(additionalPaths = []) {
    const keepPaths = new Set(
      additionalPaths.filter(Boolean).map((entry) => path.resolve(entry)),
    );
    for (const segment of playback.segments || []) {
      if (!segment?.filePath) continue;
      keepPaths.add(path.resolve(segment.filePath));
    }
    return [...keepPaths];
  }

  function requestReplayCacheMaintenance() {
    if (replayCacheLoadInProgress) return replayCacheMaintenancePromise;
    if (replayCacheMaintenancePromise) return replayCacheMaintenancePromise;
    lastReplayCacheMaintenanceMs = Date.now();
    replayCacheMaintenancePromise = enforceReplayCacheLimits(
      activeReplayCacheProtectedPaths(),
    )
      .catch((error) => {
        app.debug?.(`[${plugin.id}] replay cache maintenance failed: ${error.message}`);
      })
      .finally(() => {
        replayCacheMaintenancePromise = null;
      });
    return replayCacheMaintenancePromise;
  }

  async function enforceReplayCacheLimits(protectedPaths = []) {
    const rootPath = path.resolve(paths.voyageReplay);
    const entries = await replayCacheEntries(rootPath);
    let totalBytes = entries.reduce(
      (sum, entry) => sum + Number(entry.bytes || 0),
      0,
    );
    const maxBytes = options.replayCacheMaxGigabytes * GIBIBYTE;
    const minimumFreeBytes =
      options.replayCacheMinimumFreeGigabytes * GIBIBYTE;
    const disk = await readDiskStatus(rootPath);
    let availableBytes = Number(disk.availableBytes);
    if (!Number.isFinite(availableBytes)) availableBytes = Infinity;
    const protectedResolved = protectedPaths.map((entry) => path.resolve(entry));
    const removable = entries
      .filter((entry) =>
        !protectedResolved.some((protectedPath) =>
          replayCacheEntryContains(entry.path, protectedPath),
        ),
      )
      .sort((left, right) =>
        left.lastUsedMs - right.lastUsedMs ||
        left.path.localeCompare(right.path),
      );
    let removedEntries = 0;
    let removedBytes = 0;
    while (
      removable.length &&
      (totalBytes > maxBytes || availableBytes < minimumFreeBytes)
    ) {
      const entry = removable.shift();
      await removeReplayCacheEntry(rootPath, entry);
      totalBytes = Math.max(0, totalBytes - entry.bytes);
      availableBytes += entry.bytes;
      removedEntries += 1;
      removedBytes += entry.bytes;
    }
    if (removedEntries) {
      addEvent(
        "replay-cache-pruned",
        `Removed ${removedEntries} inactive replay cache entr${removedEntries === 1 ? "y" : "ies"} (${formatBytes(removedBytes)})`,
      );
    }
    replayCacheStatus = {
      entries: entries.length - removedEntries,
      bytes: totalBytes,
      maxBytes,
      minimumFreeBytes,
      availableBytes,
      removedEntries,
      removedBytes,
      updatedAt: new Date().toISOString(),
    };
    return replayCacheStatus;
  }

  function replayCacheEntryContains(entryPath, protectedPath) {
    if (entryPath === protectedPath) return true;
    const relative = path.relative(entryPath, protectedPath);
    return Boolean(
      relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    );
  }

  async function replayCacheEntries(rootPath) {
    const directoryEntries = await fs.promises.readdir(
      rootPath,
      { withFileTypes: true },
    ).catch(() => []);
    const result = [];
    for (const entry of directoryEntries) {
      const entryPath = path.join(rootPath, entry.name);
      if (entry.isDirectory() && entry.name === "compressed-captures") {
        const compressedFiles = await fs.promises.readdir(entryPath).catch(() => []);
        for (const name of compressedFiles.filter((value) => value.endsWith(".jsonl"))) {
          const filePath = path.join(entryPath, name);
          const relatedPaths = [
            filePath,
            recordingMetadataPath(filePath),
            replayIndexPath(filePath),
          ];
          const relatedStats = await Promise.all(
            relatedPaths.map((candidate) =>
              fs.promises.stat(candidate).catch(() => null),
            ),
          );
          result.push({
            path: filePath,
            relatedPaths,
            bytes: relatedStats.reduce(
              (sum, info) => sum + Number(info?.size || 0),
              0,
            ),
            lastUsedMs: Math.max(
              ...relatedStats.map((info) => Number(info?.mtimeMs || 0)),
            ),
          });
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      const markerStats = await fs.promises.stat(
        voyageReplayCacheManifestPath(entryPath),
      ).catch(() => null);
      const entryStats = await fs.promises.stat(entryPath).catch(() => null);
      result.push({
        path: entryPath,
        relatedPaths: [entryPath],
        bytes: await recursivePathSize(entryPath),
        lastUsedMs: Number(markerStats?.mtimeMs || entryStats?.mtimeMs || 0),
      });
    }
    return result;
  }

  async function recursivePathSize(targetPath) {
    const info = await fs.promises.lstat(targetPath).catch(() => null);
    if (!info) return 0;
    if (!info.isDirectory()) return Number(info.size || 0);
    const entries = await fs.promises.readdir(
      targetPath,
      { withFileTypes: true },
    ).catch(() => []);
    let bytes = Number(info.size || 0);
    for (const entry of entries) {
      bytes += await recursivePathSize(path.join(targetPath, entry.name));
    }
    return bytes;
  }

  async function removeReplayCacheEntry(rootPath, entry) {
    const resolved = path.resolve(entry.path);
    if (
      resolved === rootPath ||
      !resolved.startsWith(`${rootPath}${path.sep}`)
    ) {
      throw new Error(`Refusing to remove replay cache path outside ${rootPath}`);
    }
    for (const targetPath of entry.relatedPaths || [resolved]) {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
    }
  }

  async function prepareVoyagePlayback(fileName, playbackOptions = {}) {
    if (!/\.zip$/i.test(fileName)) {
      throw new Error("Voyage playback currently supports .zip voyage bundles");
    }
    ensureDirectories();
    const sourcePath = path.join(paths.voyages, fileName);
    const statsInfo = await fs.promises.stat(sourcePath).catch(() => null);
    if (!statsInfo?.isFile()) throw new Error(`Voyage not found: ${fileName}`);
    await assertSafeZipEntries(sourcePath, fileName);
    const index = await readVoyageZipIndex(sourcePath);

    const replayDirectory = path.join(paths.voyageReplay, safeReplayDirectoryName(fileName));
    await enforceReplayCacheLimits([replayDirectory]);
    let reused = await voyageReplayCacheMatches(
      replayDirectory,
      fileName,
      statsInfo,
    );
    if (!reused) {
      await rebuildVoyageReplayCache({
        sourcePath,
        fileName,
        replayDirectory,
        sourceStats: statsInfo,
      });
    } else {
      await touchPath(voyageReplayCacheManifestPath(replayDirectory));
      addEvent("replay-cache-hit", `Reused cached voyage ${fileName}`);
    }

    let captureDirectory = path.join(replayDirectory, "capture");
    let directory =
      (await directoryExists(captureDirectory))
        ? captureDirectory
        : replayDirectory;
    let segments = await listRecordingFiles(directory);
    if (!segments.length && reused) {
      reused = false;
      await rebuildVoyageReplayCache({
        sourcePath,
        fileName,
        replayDirectory,
        sourceStats: statsInfo,
      });
      captureDirectory = path.join(replayDirectory, "capture");
      directory =
        (await directoryExists(captureDirectory))
          ? captureDirectory
          : replayDirectory;
      segments = await listRecordingFiles(directory);
    }
    if (!segments.length) {
      throw new Error(`Voyage ${fileName} does not contain any AJRM Marine Logger recording segments`);
    }
    const entries = [];
    let sourceCatalog = {};
    for (const segment of segments) {
      const fullPath = path.join(directory, segment.name);
      const preparedSegment = await preparePlaybackSegment({
        name: segment.name,
        filePath: fullPath,
        directory,
      });
      sourceCatalog = mergeSourceCatalog(
        sourceCatalog,
        preparedSegment.sourceCatalog,
      );
      entries.push(preparedSegment);
    }
    entries.sort((left, right) =>
      Date.parse(left.from) - Date.parse(right.from) ||
      left.name.localeCompare(right.name),
    );
    indexPlaybackSegments(entries);
    await enforceReplayCacheLimits([
      replayDirectory,
      ...entries.map((entry) => entry.filePath),
    ]);
    const includeFullBackfill = playbackOptions.includeFullBackfill === true;
    const warmupStartedAt = includeFullBackfill
      ? null
      : replayWarmupStart(index, options.replayWarmupMinutes);
    const targetMs = Date.parse(warmupStartedAt);
    const firstSegment = Number.isFinite(targetMs)
      ? entries.find((entry) => {
          const toMs = Date.parse(entry.to || entry.from);
          return Number.isFinite(toMs) && toMs >= targetMs;
        }) || entries[entries.length - 1]
      : entries[0];
    return {
      firstSegment,
      segments: entries,
      initialCapturedAt: includeFullBackfill ? null : warmupStartedAt,
      voyageStartedAt: index?.startedAt || null,
      warmupStartedAt,
      includeFullBackfill,
      sourceCatalog,
    };
  }

  function voyageReplayCacheManifestPath(replayDirectory) {
    return path.join(replayDirectory, ".ajrm-replay-cache.json");
  }

  async function voyageReplayCacheMatches(
    replayDirectory,
    fileName,
    sourceStats,
  ) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(
        voyageReplayCacheManifestPath(replayDirectory),
        "utf8",
      ));
      return (
        parsed?.version === REPLAY_CACHE_MANIFEST_VERSION &&
        parsed.sourceFileName === fileName &&
        Number(parsed.sourceBytes) === Number(sourceStats.size) &&
        Math.abs(Number(parsed.sourceMtimeMs) - Number(sourceStats.mtimeMs)) <= 1 &&
        Math.abs(Number(parsed.sourceCtimeMs) - Number(sourceStats.ctimeMs)) <= 1
      );
    } catch (_error) {
      return false;
    }
  }

  async function rebuildVoyageReplayCache({
    sourcePath,
    fileName,
    replayDirectory,
    sourceStats,
  }) {
    await fs.promises.rm(replayDirectory, { recursive: true, force: true });
    await fs.promises.mkdir(replayDirectory, { recursive: true });
    try {
      extractZipToDirectory(sourcePath, replayDirectory);
    } catch (error) {
      throw new Error(`Unable to extract voyage ${fileName}: ${error.message || error}`);
    }
    const captureDirectory = path.join(replayDirectory, "capture");
    const directory =
      (await directoryExists(captureDirectory))
        ? captureDirectory
        : replayDirectory;
    let segments = await listRecordingFiles(directory);
    if (!segments.length) {
      await linkReferencedVoyageSegments(sourcePath, fileName, directory);
    }
    await materializeCompressedReplaySegments(directory);
    segments = await listRecordingFiles(directory);
    if (!segments.length) return;
    await fs.promises.writeFile(
      voyageReplayCacheManifestPath(replayDirectory),
      `${JSON.stringify({
        version: REPLAY_CACHE_MANIFEST_VERSION,
        sourceFileName: fileName,
        sourceBytes: sourceStats.size,
        sourceMtimeMs: sourceStats.mtimeMs,
        sourceCtimeMs: sourceStats.ctimeMs,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    addEvent("replay-cache-built", `Cached voyage ${fileName}`);
  }

  function replayWarmupStart(index, warmupMinutes) {
    const voyageStartMs = Date.parse(index?.startedAt);
    if (!Number.isFinite(voyageStartMs)) return null;
    const minutes = clampInt(warmupMinutes, 7, 0, 1440);
    return new Date(voyageStartMs - minutes * 60 * 1000).toISOString();
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
      if (existing?.isFile() && existing.size > 0) {
        await fs.promises.unlink(compressedPath).catch(() => {});
        continue;
      }
      const temporaryPath = `${plainPath}.${process.pid}.${Date.now()}.tmp`;
      await pipeline(
        fs.createReadStream(compressedPath),
        zlib.createGunzip(),
        fs.createWriteStream(temporaryPath),
      );
      await fs.promises.rename(temporaryPath, plainPath);
      await fs.promises.unlink(compressedPath).catch(() => {});
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
    if (recording && recording.kind !== "recomputed-replay") {
      throw new Error("Stop normal capture before playback");
    }
    if (recording?.kind === "recomputed-replay" && playback.lastError) {
      throw new Error(
        "Recomputed replay failed and cannot resume; abort the result capture and start a new run",
      );
    }
    if (recording?.kind === "recomputed-replay" && rate !== 1) {
      throw new Error("Recomputed replay capture is locked to 1x playback");
    }
    if (recording?.kind === "recomputed-replay" && playback.active) {
      throw new Error("Recomputed replay capture is already running and cannot be restarted");
    }
    if (isPlaybackAtEnd()) {
      if (recording?.kind === "recomputed-replay") {
        throw new Error("Stop and build the completed child voyage before replaying again");
      }
      resetPlaybackToStart("restart from end");
    }
    playback.rate = rate;
    playback.active = true;
    playback.paused = false;
    playback.lastReason = "playing";
    playback.sourceAnchorMs = null;
    playback.pacingAnchorMs = null;
    playback.lastLinePacingMs = null;
    resetCalculationFlush();
    if (recording?.kind === "recomputed-replay" && recording.replayResult) {
      recording.replayResult.rate = rate;
    }
    const generation = playbackOperation.begin();
    scheduleNextPlaybackLine(0, generation);
    addEvent("playback-started", `${playback.fileName} at ${rate}x`);
    updateProviderStatus();
  }

  function setPlaybackMode({ mode, sensorSourceIds, sensorSourcePrefixes } = {}) {
    if (!playback.loaded) throw new Error("Load a capture before selecting playback mode");
    if (playback.active || recording?.kind === "recomputed-replay") {
      throw new Error("Stop playback and recomputed replay capture before changing source policy");
    }
    playback.sourcePolicy = createSourcePolicy(
      mode,
      { sensorSourceIds, sensorSourcePrefixes },
      playback.sourceCatalog,
    );
    playback.mode = playback.sourcePolicy.mode;
    playback.filterStats = createFilterStats();
    addEvent(
      "playback-mode",
      playback.mode === PLAYBACK_MODE_SENSOR_SOURCES
        ? `Sensor-only playback: ${playback.sourcePolicy.sensorSourceIds.join(", ") || "no sources selected"}`
        : "Standard playback selected",
    );
    publishPlaybackClock(playback.paused);
    updateProviderStatus();
  }

  function isPlaybackAtEnd() {
    return playback.loaded
      && Number.isFinite(playback.totalLines)
      && playback.totalLines > 0
      && playback.cursor >= playback.totalLines;
  }

  function setPlaybackRate(rate) {
    if (!playback.loaded) throw new Error("Load a capture before setting playback speed");
    if (recording?.kind === "recomputed-replay" && rate !== 1) {
      throw new Error("Recomputed replay capture is locked to 1x playback");
    }
    const oldRate = playback.rate;
    playback.rate = rate;
    if (recording?.kind === "recomputed-replay" && recording.replayResult) {
      recording.replayResult.rate = rate;
    }
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
    if (recording?.kind === "recomputed-replay") {
      throw new Error("Recomputed replay capture cannot be paused");
    }
    playback.paused = true;
    playback.active = false;
    playback.lastReason = reason;
    playbackOperation.invalidate();
    clearTimeout(playback.timer);
    playback.timer = null;
    publishPlaybackClock(true);
    updateProviderStatus();
  }

  function finishPlayback(reason, finishOptions = {}) {
    if (!playback.loaded) return;
    playback.active = false;
    playback.paused = false;
    playback.lastReason = reason;
    if (finishOptions.error) {
      playback.lastError = playbackFailureSummary(finishOptions.error);
    }
    playback.previousTs = null;
    playback.sourceAnchorMs = null;
    playback.pacingAnchorMs = null;
    playback.lastLinePacingMs = null;
    playbackOperation.invalidate();
    clearTimeout(playback.timer);
    playback.timer = null;
    beginCalculationFlush();
    publishPlaybackClock(false);
    updateProviderStatus();
  }

  function playbackFailureSummary(error) {
    return {
      message: error?.message || String(error),
      timestamp: new Date().toISOString(),
      fileName: playback.fileName,
      displayFileName: playback.displayFileName || playback.fileName,
      sourceKind: playback.sourceKind,
      voyageFileName: playback.voyageFileName,
      segmentIndex: Number(playback.segmentIndex || 0),
      segmentCursor: Number(playback.segmentCursor || 0),
      cursor: Number(playback.cursor || 0),
      capturedAt: playback.current || null,
      originalCapturedAt: playback.originalCapturedAt || playback.current || null,
    };
  }

  function stopPlayback(reason, { force = false } = {}) {
    if (!playback.loaded && !playback.active) return;
    if (recording?.kind === "recomputed-replay" && !force) {
      throw new Error(
        "Recomputed replay capture cannot be stopped or restarted before full coverage",
      );
    }
    beginCalculationFlush();
    resetPlaybackToStart(reason);
    playback.paused = false;
    playbackOperation.invalidate();
    publishPlaybackClock(false);
    updateProviderStatus();
  }

  function resetPlaybackToStart(reason) {
    clearTimeout(playback.timer);
    playback.timer = null;
    playback.active = false;
    activatePlaybackSegment(
      playback.startSegmentIndex || 0,
      playback.startSegmentCursor || 0,
    );
    playback.cursor = playback.startCursor || 0;
    playback.current = playback.startCapturedAt || playback.from;
    playback.previousTs = null;
    playback.sourceAnchorMs = null;
    playback.pacingAnchorMs = null;
    playback.lastLinePacingMs = null;
    playback.lastReason = reason;
  }

  async function seekPlayback(target) {
    if (!playback.loaded) throw new Error("Load a capture before seeking");
    if (recording?.kind === "recomputed-replay") {
      throw new Error("Stop recomputed replay capture before seeking or restarting playback");
    }
    const targetMs = parseSeekTarget(target);
    const position = findLineAtOrAfter(targetMs);
    activatePlaybackSegment(position.segmentIndex, position.segmentCursor);
    playback.cursor = position.cursor;
    playback.current = position.capturedAt || playback.from;
    playback.previousTs = null;
    playback.lastLinePacingMs = null;
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
        finishPlayback(error.message, { error });
      });
    }, Math.max(0, delayMs));
  }

  function reschedulePlaybackForRateChange() {
    const currentMs = playback.previousTs;
    const nextMs = nextPlaybackSourceMs();
    const lastPacingMs = playback.lastLinePacingMs;
    if (
      !Number.isFinite(currentMs) ||
      !Number.isFinite(nextMs) ||
      !Number.isFinite(lastPacingMs)
    ) {
      scheduleNextPlaybackLine(0);
      return;
    }
    playback.sourceAnchorMs = currentMs;
    playback.pacingAnchorMs = playbackPacingNowMs();
    scheduleNextPlaybackLine(playbackDelayToTimestamp(nextMs));
  }

  async function sendNextPlaybackLine(generation) {
    const batchStartedMs = playbackPacingNowMs();
    let nextDelayMs = 0;
    while (true) {
      if (
        !playbackOperation.isCurrent(generation) ||
        !playback.active ||
        playback.paused
      ) {
        return;
      }
      const entry = await readEnvelopeAtLine(
        playback.filePath,
        playback.segmentCursor,
        playback.offsets,
      );
      if (
        !playbackOperation.isCurrent(generation) ||
        !playback.active ||
        playback.paused
      ) {
        return;
      }
      if (!entry) {
        if (await autoAdvancePlaybackSegment()) return;
        finishPlayback("end of capture");
        return;
      }

      playback.segmentCursor += 1;
      playback.cursor += 1;
      playback.current = entry.capturedAt;
      playback.originalCapturedAt = entry.capturedAt;
      publishPlaybackClock(true);
      const wallTimestamp = new Date().toISOString();
      const replayResult = replayDeltaWithPolicy(entry.delta, {
        timestamp: wallTimestamp,
        policy: playback.sourcePolicy,
      });
      mergeFilterStats(playback.filterStats, replayResult.stats);
      const replayDelta = replayResult.delta;
      if (replayDelta) {
        if (recording?.kind === "recomputed-replay") {
          writeRecordingEnvelope({
            capturedAt: wallTimestamp,
            originalCapturedAt: entry.capturedAt,
            replayRole: "sensor-input",
            delta: replayDelta,
          });
          stats.replayInputsCaptured += 1;
        }
        activeReplayInjection = {
          delta: replayDelta,
          fingerprint: replayDeltaFingerprint(replayDelta),
          captured: false,
        };
        rememberReplayInjection(replayDelta);
        try {
          app.handleMessage(plugin.id, replayDelta);
        } finally {
          // Signal K may normalise the context or source-priority-filter the
          // values in place. Retain that post-pipeline form as replay evidence
          // as well as the original injected form.
          rememberReplayInjection(replayDelta);
          activeReplayInjection = null;
        }
      }
      stats.playbackSent += 1;

      const currentMs = Date.parse(entry.capturedAt);
      playback.lastLinePacingMs = playbackPacingNowMs();
      if (Number.isFinite(currentMs)) {
        playback.previousTs = currentMs;
        // Anchor pacing to the most recently emitted measurement. If Signal K
        // or the host stalls, move the remaining replay later instead of
        // emitting a catch-up burst that compresses recorded sensor gaps.
        playback.sourceAnchorMs = currentMs;
        playback.pacingAnchorMs = playback.lastLinePacingMs;
      }
      nextDelayMs = playbackDelayToTimestamp(nextPlaybackSourceMs());
      if (nextDelayMs > 0 || playbackPacingNowMs() - batchStartedMs >= 40) break;
    }
    scheduleNextPlaybackLine(nextDelayMs, generation);
  }

  function playbackDelayToTimestamp(nextSourceMs) {
    if (playback.rate === "max") return 0;
    return calculatePlaybackDelayMs({
      nextSourceMs,
      sourceAnchorMs: playback.sourceAnchorMs,
      pacingAnchorMs: playback.pacingAnchorMs,
      rate: playback.rate,
      pacingNowMs: playbackPacingNowMs(),
    });
  }

  function playbackPacingNowMs() {
    const testClock = app.ajrmMarineLoggerTestHooks?.monotonicNowMs;
    if (typeof testClock === "function") {
      const testValue = Number(testClock());
      if (Number.isFinite(testValue)) return testValue;
    }
    return performance.now();
  }

  function nextPlaybackSourceMs() {
    const currentSegment = playback.segments?.[playback.segmentIndex];
    const currentTime = currentSegment?.times?.[playback.segmentCursor];
    if (Number.isFinite(currentTime)) return currentTime;
    const nextSegment = playback.segments?.[playback.segmentIndex + 1];
    return nextSegment?.times?.[0];
  }

  async function autoAdvancePlaybackSegment() {
    if (
      (!options.autoAdvancePlayback && recording?.kind !== "recomputed-replay") ||
      !playback.sourceDirectory ||
      (recording && recording.kind !== "recomputed-replay")
    ) {
      return false;
    }
    let nextSegmentIndex = playback.segmentIndex + 1;
    if (!playback.segments?.[nextSegmentIndex]) {
      if (recording?.kind === "recomputed-replay" || playback.preparedComplete) {
        return false;
      }
      const nextFile = await nextRecordingFileAfter(
        playback.sourceDirectory,
        playback,
        new Set((playback.segments || []).map((segment) => segment.name)),
      );
      if (!nextFile) {
        playback.preparedComplete = true;
        return false;
      }
      const preparedSegment = await preparePlaybackSegment({
        name: nextFile.name,
        filePath: path.join(playback.sourceDirectory, nextFile.name),
        directory: playback.sourceDirectory,
      });
      playback.segments.push(preparedSegment);
      indexPlaybackSegments(playback.segments);
      playback.totalLines = totalPreparedLines();
      playback.captureTo = latestIsoTimestamp(
        playback.captureTo,
        preparedSegment.to,
      );
      playback.to = playback.captureTo;
      playback.sourceCatalog = mergeSourceCatalog(
        playback.sourceCatalog,
        preparedSegment.sourceCatalog,
      );
      playback.sourcePolicy = createSourcePolicy(
        playback.sourcePolicy.mode,
        {
          sensorSourceIds: playback.sourcePolicy.explicitSensorSourceIds,
          sensorSourcePrefixes: playback.sourcePolicy.sensorSourcePrefixes,
        },
        playback.sourceCatalog,
      );
      nextSegmentIndex = playback.segments.length - 1;
    }

    const previousSourceMs = Date.parse(playback.current || "");
    const previousPacingMs = Number.isFinite(playback.lastLinePacingMs)
      ? playback.lastLinePacingMs
      : playbackPacingNowMs();
    activatePlaybackSegment(nextSegmentIndex, 0);
    playback.active = true;
    playback.paused = false;
    playback.lastReason = "playing next segment";
    playback.sourceAnchorMs = Number.isFinite(previousSourceMs)
      ? previousSourceMs
      : null;
    playback.pacingAnchorMs = Number.isFinite(previousSourceMs)
      ? previousPacingMs
      : null;
    playback.lastLinePacingMs = Number.isFinite(previousSourceMs)
      ? previousPacingMs
      : null;
    const generation = playbackOperation.begin();
    stats.autoAdvanced += 1;
    addEvent("playback-next", `Continuing with ${playback.fileName}`);
    publishPlaybackClock(true);
    scheduleNextPlaybackLine(
      playbackDelayToTimestamp(nextPlaybackSourceMs()),
      generation,
    );
    updateProviderStatus();
    return true;
  }

  async function deleteRecordingFile({ kind, fileName }) {
    const directory = recordingDirectoryForKind(kind);
    if (recording?.fileName === fileName) {
      throw new Error("Stop capture before deleting the active log file");
    }
    if (activeReplayResultSessionHasFile(fileName)) {
      throw new Error(
        "Finish or abort the recomputed replay capture before deleting one of its result segments",
      );
    }
    if (playback.loaded && playback.fileName === fileName) {
      throw new Error("Stop playback or load another file before deleting this file");
    }
    const filePath = path.join(directory, fileName);
    const statsInfo = await fs.promises.stat(filePath).catch(() => null);
    if (!statsInfo?.isFile()) throw new Error(`File not found: ${fileName}`);
    await fs.promises.unlink(filePath);
    await fs.promises.unlink(recordingMetadataPath(filePath)).catch(() => {});
    clearRecordingMetadataFailure(filePath);
    addEvent("file-deleted", `Deleted ${fileName}`);
    return { kind: normalizeRecordingKind(kind), fileName };
  }

  function activeReplayResultSessionHasFile(fileName) {
    const session = recording?.kind === "recomputed-replay"
      ? recording.resultCaptureSession
      : null;
    if (!session) return false;
    return session.segments.some((entry) => {
      const names = [
        entry.fileName,
        path.basename(entry.filePath || ""),
        path.basename(entry.finalPath || ""),
      ].filter(Boolean);
      return names.includes(fileName);
    });
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
      replayCache: replayCacheStatus,
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
      const index = await cachedVoyageZipIndex(fullPath, info);
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

  async function cachedVoyageZipIndex(fullPath, info) {
    const cacheKey = `${fullPath}:${info.size}:${info.mtimeMs}`;
    if (voyageMetadataCache.has(cacheKey)) {
      return voyageMetadataCache.get(cacheKey);
    }
    if (voyageMetadataJobs.has(cacheKey)) {
      return voyageMetadataJobs.get(cacheKey);
    }
    for (const key of voyageMetadataCache.keys()) {
      if (key.startsWith(`${fullPath}:`)) voyageMetadataCache.delete(key);
    }
    const job = readVoyageZipIndex(fullPath)
      .then((index) => {
        voyageMetadataCache.set(cacheKey, index);
        return index;
      })
      .finally(() => {
        voyageMetadataJobs.delete(cacheKey);
      });
    voyageMetadataJobs.set(cacheKey, job);
    return job;
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
        metadataError: meta.metadataError || null,
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

    const failure = recordingMetadataFailureForFile(fullPath, file);
    if (failure) return recordingMetadataFailureSummary(failure);

    const sidecar = readRecordingMetadataFileSync(fullPath, file);
    if (sidecar) {
      clearRecordingMetadataFailure(fullPath);
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

    const failure = recordingMetadataFailureForFile(fullPath, file);
    if (failure) return recordingMetadataFailureSummary(failure);

    const sidecar = await readRecordingMetadataFile(fullPath, file);
    if (sidecar) {
      clearRecordingMetadataFailure(fullPath);
      recordingMetadataCache.set(cacheKey, sidecar);
      return sidecar;
    }

    for (const key of recordingMetadataCache.keys()) {
      if (key.startsWith(`${fullPath}:`)) recordingMetadataCache.delete(key);
    }
    const meta = await generateRecordingMetadataTracked(
      fullPath,
      "metadata-missing",
    );
    return meta || recordingMetadataFailureSummary(
      recordingMetadataFailures.get(fullPath),
    );
  }

  function queueRecordingMetadata(filePath, reason) {
    if (!filePath || recording?.filePath === filePath) return;
    if (recordingMetadataJobs.has(filePath)) return;
    const signature = recordingFileSignatureSync(filePath);
    const failure = recordingMetadataFailures.get(filePath);
    if (failure && failure.signature === signature) return;
    if (failure) recordingMetadataFailures.delete(filePath);
    recordingMetadataJobs.add(filePath);
    setTimeout(() => {
      generateRecordingMetadataTracked(filePath, reason, { signature })
        .finally(() => recordingMetadataJobs.delete(filePath));
    }, 0);
  }

  async function generateRecordingMetadataTracked(
    filePath,
    reason,
    trackingOptions = {},
  ) {
    const signature =
      trackingOptions.signature || recordingFileSignatureSync(filePath);
    try {
      const meta = await generateRecordingMetadata(filePath, reason);
      clearRecordingMetadataFailure(filePath);
      return meta;
    } catch (error) {
      rememberRecordingMetadataFailure(filePath, signature, error, reason);
      if (trackingOptions.rethrow === true) throw error;
      return null;
    }
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

  function recordingFileSignature(file) {
    if (!file) return null;
    const size = Number(file.size);
    const mtimeMs = Number(file.mtimeMs);
    if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return null;
    return `${size}:${mtimeMs}`;
  }

  function recordingFileSignatureSync(filePath) {
    try {
      return recordingFileSignature(fs.statSync(filePath));
    } catch (_error) {
      return null;
    }
  }

  function recordingMetadataFailureForFile(filePath, file) {
    const failure = recordingMetadataFailures.get(filePath);
    if (!failure) return null;
    const signature = recordingFileSignature(file);
    if (signature && failure.signature === signature) return failure;
    recordingMetadataFailures.delete(filePath);
    return null;
  }

  function recordingMetadataFailureSummary(failure) {
    return {
      lines: null,
      from: null,
      to: null,
      metadataPending: false,
      metadataError: failure?.error || "Metadata generation failed",
    };
  }

  function rememberRecordingMetadataFailure(filePath, signature, error, reason) {
    const errorMessage = error?.message || String(error);
    const previous = recordingMetadataFailures.get(filePath);
    const failure = {
      signature,
      error: errorMessage,
      reason: reason || null,
      failedAt: new Date().toISOString(),
    };
    recordingMetadataFailures.set(filePath, failure);
    if (
      !previous ||
      previous.signature !== failure.signature ||
      previous.error !== failure.error
    ) {
      logError(
        `metadata generation failed for ${path.basename(filePath)}`,
        error,
      );
    }
    return failure;
  }

  function clearRecordingMetadataFailure(filePath) {
    if (filePath) recordingMetadataFailures.delete(filePath);
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
    const tempPath =
      `${filePath}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.meta.json.tmp`;
    try {
      await fs.promises.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
      await fs.promises.rename(tempPath, metadataPath);
    } finally {
      await fs.promises.unlink(tempPath).catch(() => {});
    }
    const cacheKey = `${filePath}:${fileStats.size}:${fileStats.mtimeMs}`;
    recordingMetadataCache.set(cacheKey, {
      lines: payload.lines,
      from: payload.from,
      to: payload.to,
    });
    return payload;
  }

  async function nextRecordingFileAfter(directory, current, excludedNames = new Set()) {
    const files = await listRecordingFiles(directory);
    const currentEndMs = Date.parse(current.to || current.current);
    const entries = [];
    for (const file of files) {
      if (file.name === current.fileName) continue;
      if (excludedNames.has(file.name)) continue;
      if (file.name === recording?.fileName) continue;
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

  async function scanFile(
    filePath,
    maxLines = Infinity,
    buildIndex = false,
    buildSourceCatalog = buildIndex,
  ) {
    const canUseOffsets = buildIndex && !isCompressedLogName(filePath);
    const meta = {
      lines: 0,
      from: null,
      to: null,
      offsets: buildIndex ? [] : undefined,
      times: buildIndex ? [] : undefined,
      sourceCatalog: buildSourceCatalog ? {} : undefined,
      compressed: isCompressedLogName(filePath),
    };
    await readEnvelopes(filePath, async (envelope) => {
      meta.lines += 1;
      updateMetadataRange(meta, envelope.capturedAt);
      if (buildIndex) {
        meta.offsets.push(canUseOffsets ? envelope.__offset : null);
        meta.times.push(Date.parse(envelope.capturedAt));
      }
      if (buildSourceCatalog) {
        sourceCatalogFromDelta(envelope.delta, meta.sourceCatalog);
      }
      if (meta.lines >= maxLines && maxLines !== Infinity) {
        meta.partial = true;
      }
    }, maxLines, { includeOffsets: buildIndex });
    return meta;
  }

  function mergeSourceCatalog(left = {}, right = {}) {
    const output = {};
    for (const catalog of [left, right]) {
      for (const [sourceId, counts] of Object.entries(catalog || {})) {
        const current = output[sourceId] || { updates: 0, values: 0 };
        current.updates += Number(counts?.updates || 0);
        current.values += Number(counts?.values || 0);
        output[sourceId] = current;
      }
    }
    return output;
  }

  function earliestIsoTimestamp(left, right) {
    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    if (!Number.isFinite(leftMs)) return right || null;
    if (!Number.isFinite(rightMs)) return left || null;
    return leftMs <= rightMs ? left : right;
  }

  function latestIsoTimestamp(left, right) {
    const leftMs = Date.parse(left);
    const rightMs = Date.parse(right);
    if (!Number.isFinite(leftMs)) return right || null;
    if (!Number.isFinite(rightMs)) return left || null;
    return leftMs >= rightMs ? left : right;
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

  async function readEnvelopeAtLine(filePath, lineIndex, offsets = playback.offsets) {
    const offset = offsets?.[lineIndex];
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
    if (!Number.isFinite(targetMs)) {
      const first = playback.segments?.[0];
      return {
        segmentIndex: 0,
        segmentCursor: 0,
        cursor: 0,
        capturedAt: first?.from || playback.from,
      };
    }
    const segments = playback.segments || [];
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      const times = segment.times || [];
      if (!times.length || times[times.length - 1] < targetMs) continue;
      let low = 0;
      let high = times.length - 1;
      let best = times.length - 1;
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
        segmentIndex,
        segmentCursor: best,
        cursor: Number(segment.baseCursor || 0) + best,
        capturedAt: Number.isFinite(times[best])
          ? new Date(times[best]).toISOString()
          : segment.from,
      };
    }
    const segmentIndex = Math.max(0, segments.length - 1);
    const segment = segments[segmentIndex];
    const segmentCursor = Math.max(0, Number(segment?.lines || 1) - 1);
    return {
      segmentIndex,
      segmentCursor,
      cursor: Number(segment?.baseCursor || 0) + segmentCursor,
      capturedAt: Number.isFinite(segment?.times?.[segmentCursor])
        ? new Date(segment.times[segmentCursor]).toISOString()
        : segment?.from || playback.from,
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
      startCursor: 0,
      from: null,
      to: null,
      current: null,
      startCapturedAt: null,
      captureFrom: null,
      captureTo: null,
      voyageStartedAt: null,
      warmupStartedAt: null,
      includeFullBackfill: false,
      mode: "standard",
      sourcePolicy: createSourcePolicy("standard", {
        sensorSourceIds: DEFAULT_SENSOR_SOURCE_IDS,
        sensorSourcePrefixes: DEFAULT_SENSOR_SOURCE_PREFIXES,
      }),
      sourceCatalog: {},
      filterStats: createFilterStats(),
      liveInputIsolation: createLiveInputIsolation(),
      calculationFlushStartedAtMs: null,
      calculationFlushUntilMs: null,
      calculationFlushMaxUntilMs: null,
      calculationFlushOutputCount: 0,
      calculationFlushTimer: null,
      originalCapturedAt: null,
      rate: 1,
      previousTs: null,
      sourceAnchorMs: null,
      pacingAnchorMs: null,
      lastLinePacingMs: null,
      timer: null,
      lastReason: "not loaded",
      lastError: null,
      offsets: [],
      times: [],
      segments: [],
      segmentIndex: 0,
      segmentCursor: 0,
      startSegmentIndex: 0,
      startSegmentCursor: 0,
      preparedComplete: false,
    };
  }

  function getRecordingSummary() {
    if (!recording) return null;
    return {
      active: true,
      fileName: recording.fileName,
      startedAt: recording.startedAt,
      backfillMinutes: recording.backfillMinutes,
      kind: recording.kind || "live",
      backfilled: recording.backfilled,
      lines: recording.lines,
      from: recording.from,
      to: recording.to,
      bytes: fileSize(recording.filePath),
      replayResult: recording.kind === "recomputed-replay"
        ? replayResultSummary(recording)
        : null,
    };
  }

  function replayResultSummary(
    segment,
    resultSegments = replayResultSegmentManifestSnapshot(
      segment?.resultCaptureSession,
    ),
    resultOptions = {},
  ) {
    const inputCoverage = resultOptions.inputCoverage || buildPlaybackCoverage();
    const aborted =
      resultOptions.aborted === true ||
      segment?.resultCaptureSession?.aborted === true;
    const abortReason = aborted
      ? String(
          resultOptions.abortReason ||
          segment?.resultCaptureSession?.abortReason ||
          "recomputed replay capture aborted",
        )
      : null;
    const coverage = {
      ...inputCoverage,
      inputComplete: inputCoverage.complete === true,
      resultSegmentsComplete: resultSegments?.complete === true,
      complete:
        !aborted &&
        inputCoverage.complete === true &&
        resultSegments?.complete === true,
      aborted,
      abortReason,
    };
    return {
      ...segment.replayResult,
      aborted,
      incomplete: aborted || coverage.complete !== true,
      abortReason,
      playbackFailed: Boolean(playback.lastError),
      playbackError: playback.lastError ? { ...playback.lastError } : null,
      sourcePolicy: playback.sourcePolicy,
      sourceCatalog: playback.sourceCatalog,
      originalFrom: playback.captureFrom || segment.replayResult.originalFrom,
      originalTo: playback.captureTo || segment.replayResult.originalTo,
      originalCapturedAt: playback.originalCapturedAt,
      sourceFilterStats: playback.filterStats,
      liveInputIsolation: playback.liveInputIsolation,
      resultSegments,
      coverage,
      calculationFlushUntil: Number.isFinite(playback.calculationFlushUntilMs)
        ? new Date(playback.calculationFlushUntilMs).toISOString()
        : null,
      calculationFlush: calculationFlushSummary(),
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
      startCursor: playback.startCursor,
      from: playback.from,
      to: playback.to,
      current: playback.current,
      captureFrom: playback.captureFrom,
      captureTo: playback.captureTo,
      voyageStartedAt: playback.voyageStartedAt,
      warmupStartedAt: playback.warmupStartedAt,
      warmupActive: isPlaybackWarmupActive(),
      includeFullBackfill: playback.includeFullBackfill,
      replayWarmupMinutes: options.replayWarmupMinutes,
      mode: playback.mode,
      replayMode: playbackModeContract(playback.mode),
      originalCapturedAt: playback.originalCapturedAt || playback.current,
      sourcePolicy: playback.sourcePolicy,
      sourceCatalog: playback.sourceCatalog,
      sourceFilterStats: playback.filterStats,
      liveInputIsolation: playback.liveInputIsolation,
      coverage: buildPlaybackCoverage(),
      calculationFlushUntil: Number.isFinite(playback.calculationFlushUntilMs)
        ? new Date(playback.calculationFlushUntilMs).toISOString()
        : null,
      calculationFlush: calculationFlushSummary(),
      calculationFlushActive:
        Number.isFinite(playback.calculationFlushUntilMs) &&
        Date.now() <= playback.calculationFlushUntilMs,
      resultCapture: recording?.kind === "recomputed-replay"
        ? {
            active: true,
            fileName: recording.fileName,
            startedAt: recording.startedAt,
            lines: recording.lines,
          }
        : { active: false },
      rate: playback.rate,
      lastReason: playback.lastReason,
      lastError: playback.lastError ? { ...playback.lastError } : null,
      compressed: isCompressedLogName(playback.fileName || ""),
      autoAdvance: options.autoAdvancePlayback,
    };
  }

  function buildPlaybackCoverage() {
    const startCursor = Number(playback.startCursor || 0);
    const cursor = Number(playback.cursor || 0);
    const totalLines = Number(playback.totalLines || 0);
    const segments = (playback.segments || []).map((segment, index) => {
      const replayStartLine = index < playback.startSegmentIndex
        ? Number(segment.lines || 0)
        : index === playback.startSegmentIndex
          ? Number(playback.startSegmentCursor || 0)
          : 0;
      let reachedLine = 0;
      if (index < playback.segmentIndex) {
        reachedLine = Number(segment.lines || 0);
      } else if (index === playback.segmentIndex) {
        reachedLine = Number(playback.segmentCursor || 0);
      }
      const replayableLines = Math.max(
        0,
        Number(segment.lines || 0) - replayStartLine,
      );
      const replayedLines = Math.max(
        0,
        Math.min(Number(segment.lines || 0), reachedLine) - replayStartLine,
      );
      return {
        index,
        fileName: segment.name,
        from: segment.from,
        to: segment.to,
        lines: Number(segment.lines || 0),
        baseCursor: Number(segment.baseCursor || 0),
        replayStartLine,
        replayableLines,
        replayedLines,
        complete: replayedLines >= replayableLines,
        excludedBeforeReplayStart: replayableLines === 0,
      };
    });
    const replaySegments = segments.filter((segment) => !segment.excludedBeforeReplayStart);
    return {
      complete:
        playback.preparedComplete === true &&
        totalLines > startCursor &&
        cursor >= totalLines &&
        playback.segmentIndex >= Math.max(0, playback.segments.length - 1),
      startCursor,
      cursor,
      totalLines,
      replayableLines: Math.max(0, totalLines - startCursor),
      replayedLines: Math.max(0, cursor - startCursor),
      segmentsTotal: replaySegments.length,
      segmentsCompleted: replaySegments.filter((segment) => segment.complete).length,
      loadedSegmentsTotal: segments.length,
      preparedComplete: playback.preparedComplete === true,
      segments,
      lastReason: playback.lastReason,
      originalCapturedAt:
        playback.originalCapturedAt || playback.current || null,
    };
  }

  function calculationFlushSummary() {
    return {
      quietPeriodMs: calculationFlushQuietMs(),
      maximumDurationMs: calculationFlushMaxMs(),
      startedAt: Number.isFinite(playback.calculationFlushStartedAtMs)
        ? new Date(playback.calculationFlushStartedAtMs).toISOString()
        : null,
      quietUntil: Number.isFinite(playback.calculationFlushUntilMs)
        ? new Date(playback.calculationFlushUntilMs).toISOString()
        : null,
      maximumUntil: Number.isFinite(playback.calculationFlushMaxUntilMs)
        ? new Date(playback.calculationFlushMaxUntilMs).toISOString()
        : null,
      outputsDuringQuietPeriod: Number(playback.calculationFlushOutputCount || 0),
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
                    voyageStartedAt: playback.voyageStartedAt,
                    warmupStartedAt: playback.warmupStartedAt,
                    warmupActive: isPlaybackWarmupActive(),
                    includeFullBackfill: playback.includeFullBackfill,
                    originalCapturedAt: playback.originalCapturedAt || playback.current,
                    mode: playback.mode,
                    replayMode: playbackModeContract(playback.mode),
                    sourcePolicy: playback.sourcePolicy,
                    sourceFilterStats: playback.filterStats,
                    liveInputIsolation: playback.liveInputIsolation,
                    calculationFlushUntil: Number.isFinite(playback.calculationFlushUntilMs)
                      ? new Date(playback.calculationFlushUntilMs).toISOString()
                      : null,
                    calculationFlushActive:
                      Number.isFinite(playback.calculationFlushUntilMs) &&
                      Date.now() <= playback.calculationFlushUntilMs,
                    resultCapture: recording?.kind === "recomputed-replay",
                    playing: playback.active,
                    rate: playback.rate,
                    lastError: playback.lastError ? { ...playback.lastError } : null,
                  }
                : {
                    active: false,
                    fileName: playback.fileName,
                    displayFileName: playback.displayFileName || playback.fileName,
                    sourceKind: playback.sourceKind,
                    voyageFileName: playback.voyageFileName,
                    voyageStartedAt: playback.voyageStartedAt,
                    warmupStartedAt: playback.warmupStartedAt,
                    warmupActive: false,
                    includeFullBackfill: playback.includeFullBackfill,
                    originalCapturedAt: playback.originalCapturedAt || playback.current,
                    mode: playback.mode,
                    replayMode: playbackModeContract(playback.mode),
                    sourcePolicy: playback.sourcePolicy,
                    sourceFilterStats: playback.filterStats,
                    liveInputIsolation: playback.liveInputIsolation,
                    calculationFlushUntil: Number.isFinite(playback.calculationFlushUntilMs)
                      ? new Date(playback.calculationFlushUntilMs).toISOString()
                      : null,
                    calculationFlushActive:
                      Number.isFinite(playback.calculationFlushUntilMs) &&
                      Date.now() <= playback.calculationFlushUntilMs,
                    resultCapture: recording?.kind === "recomputed-replay",
                    lastError: playback.lastError ? { ...playback.lastError } : null,
                  },
            },
          ],
        },
      ],
    });
  }

  function isPlaybackWarmupActive() {
    const voyageStartMs = Date.parse(playback.voyageStartedAt);
    const currentMs = Date.parse(playback.current);
    return Number.isFinite(voyageStartMs)
      && Number.isFinite(currentMs)
      && currentMs < voyageStartMs;
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
      `AJRM Marine Logger v${packageInfo.version}: ${recordingText}${playbackText}`,
    );
  }

  function defaultLogDirectory() {
    const preferred = expandHome(DEFAULT_LOG_DIRECTORY);
    const legacy = expandHome(LEGACY_LOG_DIRECTORY);
    return !fs.existsSync(preferred) && fs.existsSync(legacy) ? LEGACY_LOG_DIRECTORY : DEFAULT_LOG_DIRECTORY;
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

async function validateGzipReadable(filePath) {
  await pipeline(
    fs.createReadStream(filePath),
    zlib.createGunzip(),
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

async function plainAndGzipContentsMatch(plainPath, gzipPath) {
  const [plain, compressed] = await Promise.all([
    recordingContentDigest(plainPath, false),
    recordingContentDigest(gzipPath, true),
  ]);
  return (
    plain.bytes === compressed.bytes &&
    plain.sha256 === compressed.sha256
  );
}

async function recordingContentDigest(filePath, compressed) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback();
    },
  });
  if (compressed) {
    await pipeline(
      fs.createReadStream(filePath),
      zlib.createGunzip(),
      sink,
    );
  } else {
    await pipeline(fs.createReadStream(filePath), sink);
  }
  return {
    bytes,
    sha256: hash.digest("hex"),
  };
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
  try {
    const unsafe = zipEntryNames(filePath)
      .find((entry) => unsafeZipEntryName(entry));
    if (unsafe) {
      throw new Error(`Voyage ${fileName} contains an unsafe archive path: ${unsafe}`);
    }
  } catch (error) {
    throw new Error(`Unable to inspect voyage ${fileName}: ${error.message || error}`);
  }
}

async function readVoyageZipIndex(filePath) {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        zip.close();
        resolve(value);
      };
      zip.once("error", () => finish(null));
      zip.once("end", () => finish(null));
      zip.on("entry", (entry) => {
        if (
          entry.fileName !== "index.json" ||
          /\/$/.test(entry.fileName) ||
          entry.uncompressedSize > MAX_VOYAGE_INDEX_BYTES
        ) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(null);
            return;
          }
          const chunks = [];
          let bytes = 0;
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes <= MAX_VOYAGE_INDEX_BYTES) chunks.push(chunk);
            else stream.destroy(new Error("Voyage index is too large"));
          });
          stream.once("error", () => finish(null));
          stream.once("end", () => {
            try {
              finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (_error) {
              finish(null);
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}

function zipEntryNames(filePath) {
  return new AdmZip(filePath).getEntries().map((entry) => entry.entryName);
}

function unsafeZipEntryName(entryName) {
  return path.isAbsolute(entryName) || entryName.split(/[\\/]+/).includes("..");
}

function extractZipToDirectory(filePath, directory) {
  const zip = new AdmZip(filePath);
  for (const entry of zip.getEntries()) {
    if (unsafeZipEntryName(entry.entryName)) {
      throw new Error(`unsafe archive path: ${entry.entryName}`);
    }
  }
  zip.extractAllTo(directory, true);
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
  return replayDeltaWithPolicy(delta, {
    timestamp,
    policy: createSourcePolicy("standard", {
      sensorSourceIds: DEFAULT_SENSOR_SOURCE_IDS,
      sensorSourcePrefixes: DEFAULT_SENSOR_SOURCE_PREFIXES,
    }),
  }).delta;
}

function createLiveInputIsolation() {
  return {
    required: true,
    method: "quarantine-physical-source-deltas-during-result-capture",
    valid: true,
    physicalUpdatesSeen: 0,
    physicalValuesSeen: 0,
    sources: {},
    delayedReplayEchoUpdatesIgnored: 0,
    delayedReplayEchoValuesIgnored: 0,
    delayedReplayEchoSources: {},
    unmatchedPhysicalSamples: [],
    warning:
      "Disable or disconnect live sensor inputs during replay. Timestamped replay echoes, including Signal K filtered/rebatched subsets, are identified separately; other physical deltas are quarantined from the child log but may influence live calculations before capture. Normal sailing capture is unaffected.",
  };
}

function recordDelayedReplayEcho(isolation, delta) {
  if (!isolation) return;
  for (const update of delta?.updates || []) {
    const sourceId = sourceIdentityForUpdate(delta, update) || "(missing)";
    const valueCount = Array.isArray(update?.values) ? update.values.length : 0;
    isolation.delayedReplayEchoUpdatesIgnored =
      Number(isolation.delayedReplayEchoUpdatesIgnored || 0) + 1;
    isolation.delayedReplayEchoValuesIgnored =
      Number(isolation.delayedReplayEchoValuesIgnored || 0) + valueCount;
    isolation.delayedReplayEchoSources[sourceId] =
      Number(isolation.delayedReplayEchoSources[sourceId] || 0) + valueCount;
  }
}

function quarantinePhysicalSourceUpdates(delta, policy) {
  const isolation = createLiveInputIsolation();
  isolation.required = true;
  const updates = [];
  for (const update of delta?.updates || []) {
    const sourceId = sourceIdentityForUpdate(delta, update);
    if (sourceMatchesPhysicalPolicy(sourceId, policy)) {
      const valueCount = Array.isArray(update?.values) ? update.values.length : 0;
      isolation.physicalUpdatesSeen += 1;
      isolation.physicalValuesSeen += valueCount;
      isolation.sources[sourceId || "(missing)"] =
        Number(isolation.sources[sourceId || "(missing)"] || 0) + valueCount;
      if (isolation.unmatchedPhysicalSamples.length < 12) {
        isolation.unmatchedPhysicalSamples.push({
          observedAt: new Date().toISOString(),
          source: sourceId || "(missing)",
          timestamp: update?.timestamp || null,
          pgn: update?.source?.pgn ?? null,
          paths: (update?.values || [])
            .map((entry) => String(entry?.path || ""))
            .filter(Boolean)
            .slice(0, 12),
        });
      }
      isolation.valid = false;
      continue;
    }
    updates.push(update);
  }
  return {
    delta: updates.length ? { ...delta, updates } : null,
    isolation,
  };
}

function mergeLiveInputIsolation(target, addition) {
  if (!target || !addition) return target;
  target.physicalUpdatesSeen += Number(addition.physicalUpdatesSeen || 0);
  target.physicalValuesSeen += Number(addition.physicalValuesSeen || 0);
  for (const [sourceId, count] of Object.entries(addition.sources || {})) {
    target.sources[sourceId] = Number(target.sources[sourceId] || 0) + Number(count || 0);
  }
  if (!Array.isArray(target.unmatchedPhysicalSamples)) {
    target.unmatchedPhysicalSamples = [];
  }
  for (const sample of addition.unmatchedPhysicalSamples || []) {
    if (target.unmatchedPhysicalSamples.length >= 12) break;
    target.unmatchedPhysicalSamples.push(sample);
  }
  target.valid = target.physicalUpdatesSeen === 0;
  return target;
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

function positiveTestDuration(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizePlaybackRate(value, fallback = 1) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "max" || text === "maximum") return "max";
  if (fallback === "max" && (value === undefined || value === null || value === "")) return "max";
  return clampNumber(value, fallback === "max" ? 1 : fallback, 0.1, 20);
}

function playbackModeContract(mode) {
  return mode === PLAYBACK_MODE_SENSOR_SOURCES ? "sensor-only" : "standard";
}

function calculatePlaybackDelayMs({
  nextSourceMs,
  sourceAnchorMs,
  pacingAnchorMs,
  rate,
  pacingNowMs,
}) {
  if (rate === "max") return 0;
  const numericRate = Number(rate || 1);
  if (
    !Number.isFinite(nextSourceMs) ||
    !Number.isFinite(sourceAnchorMs) ||
    !Number.isFinite(pacingAnchorMs) ||
    !Number.isFinite(pacingNowMs) ||
    !Number.isFinite(numericRate) ||
    numericRate <= 0
  ) {
    return 0;
  }
  const targetPacingMs =
    pacingAnchorMs + Math.max(0, nextSourceMs - sourceAnchorMs) / numericRate;
  return Math.max(0, targetPacingMs - pacingNowMs);
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= GIBIBYTE) return `${(bytes / GIBIBYTE).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.max(0, Math.round(bytes))} bytes`;
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
  replayDeltaWithPolicy,
  createSourcePolicy,
  normalizeSensorSourceIds,
  shouldReplayInputPath,
};
