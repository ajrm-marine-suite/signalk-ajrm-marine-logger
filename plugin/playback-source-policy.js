"use strict";

const PLAYBACK_MODE_STANDARD = "standard";
const PLAYBACK_MODE_SENSOR_SOURCES = "sensor-sources";
const PLAYBACK_MODES = new Set([
  PLAYBACK_MODE_STANDARD,
  PLAYBACK_MODE_SENSOR_SOURCES,
]);
const SENSOR_SOURCE_POLICY_ID = "strict-recorded-sensor-source-allowlist-v1";
const DEFAULT_SENSOR_SOURCE_PREFIXES = Object.freeze(["YDEN"]);
const DEFAULT_SENSOR_SOURCE_IDS = Object.freeze([]);
const ALWAYS_EXCLUDED_NAMESPACES = Object.freeze(["plugins", "notifications"]);

function normalizePlaybackMode(value) {
  return PLAYBACK_MODES.has(value) ? value : PLAYBACK_MODE_STANDARD;
}

function normalizeSensorSourceIds(value, fallback = DEFAULT_SENSOR_SOURCE_IDS) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : fallback;
  return Array.from(new Set(
    entries
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
}

function normalizeSensorSourcePrefixes(
  value,
  fallback = DEFAULT_SENSOR_SOURCE_PREFIXES,
) {
  return normalizeSensorSourceIds(value, fallback);
}

function createSourcePolicy(mode, sourceSelection, sourceCatalog = {}) {
  const normalizedMode = normalizePlaybackMode(mode);
  const legacyExactSelection = Array.isArray(sourceSelection) ||
    typeof sourceSelection === "string";
  const explicitSensorSourceIds = normalizeSensorSourceIds(
    legacyExactSelection
      ? sourceSelection
      : sourceSelection?.sensorSourceIds,
  );
  const sensorSourcePrefixes = normalizeSensorSourcePrefixes(
    legacyExactSelection
      ? []
      : sourceSelection?.sensorSourcePrefixes,
  );
  const resolvedSensorSourceIds = resolveSensorSourceIds({
    sourceCatalog,
    sensorSourcePrefixes,
    explicitSensorSourceIds,
  });
  const recordedSourceIds = new Set(
    Object.keys(sourceCatalog || {}).filter((sourceId) => sourceId !== "(missing)"),
  );
  const matchedExplicitSensorSourceIds = explicitSensorSourceIds.filter(
    (sourceId) => recordedSourceIds.has(sourceId),
  );
  const unmatchedExplicitSensorSourceIds = explicitSensorSourceIds.filter(
    (sourceId) => !recordedSourceIds.has(sourceId),
  );
  return {
    id: normalizedMode === PLAYBACK_MODE_SENSOR_SOURCES
      ? SENSOR_SOURCE_POLICY_ID
      : "standard-non-derived-path-replay-v1",
    mode: normalizedMode,
    sourceIdentityFieldOrder: [
      "update.$source",
      "update.source.label",
      "delta.$source",
      "delta.source.label",
    ],
    selectionRule: "exact-or-prefix-catalog-resolution",
    sensorSourcePrefixes,
    explicitSensorSourceIds,
    matchedExplicitSensorSourceIds,
    unmatchedExplicitSensorSourceIds,
    resolvedSensorSourceIds,
    sensorSourceIds: resolvedSensorSourceIds,
    missingSourceAction: normalizedMode === PLAYBACK_MODE_SENSOR_SOURCES
      ? "exclude"
      : "include",
    unlistedSourceAction: normalizedMode === PLAYBACK_MODE_SENSOR_SOURCES
      ? "exclude"
      : "include",
    alwaysExcludedNamespaces: [...ALWAYS_EXCLUDED_NAMESPACES],
  };
}

function resolveSensorSourceIds({
  sourceCatalog = {},
  sensorSourcePrefixes = DEFAULT_SENSOR_SOURCE_PREFIXES,
  explicitSensorSourceIds = [],
} = {}) {
  const catalogSourceIds = Object.keys(sourceCatalog || {})
    .filter((sourceId) => sourceId !== "(missing)");
  const recorded = new Set(catalogSourceIds);
  const resolved = new Set(
    normalizeSensorSourceIds(explicitSensorSourceIds, [])
      .filter((sourceId) => recorded.has(sourceId)),
  );
  const prefixes = normalizeSensorSourcePrefixes(sensorSourcePrefixes);
  for (const sourceId of catalogSourceIds) {
    if (prefixes.some((prefix) => sourceMatchesPrefix(sourceId, prefix))) {
      resolved.add(sourceId);
    }
  }
  return Array.from(resolved).sort((left, right) => left.localeCompare(right));
}

function sourceMatchesPrefix(sourceId, prefix) {
  const source = String(sourceId || "").trim();
  const configuredPrefix = String(prefix || "").trim().replace(/\.+$/, "");
  return Boolean(
    source &&
    configuredPrefix &&
    (source === configuredPrefix || source.startsWith(`${configuredPrefix}.`)),
  );
}

function sourceMatchesPhysicalPolicy(sourceId, policy) {
  if (!sourceId) return false;
  const exactSensorSourceIds = new Set([
    ...(policy?.resolvedSensorSourceIds || []),
    ...(policy?.sensorSourceIds || []),
    ...(policy?.explicitSensorSourceIds || []),
  ]);
  if (exactSensorSourceIds.has(sourceId)) {
    return true;
  }
  return (policy?.sensorSourcePrefixes || []).some((prefix) =>
    sourceMatchesPrefix(sourceId, prefix),
  );
}

function createFilterStats() {
  return {
    recordsSeen: 0,
    recordsSent: 0,
    updatesSeen: 0,
    updatesSent: 0,
    valuesSeen: 0,
    valuesSent: 0,
    valuesExcluded: 0,
    excludedByReason: {
      pathNamespace: 0,
      missingSource: 0,
      sourceNotAllowed: 0,
      emptyAfterSanitizing: 0,
    },
    sources: {},
  };
}

function mergeFilterStats(target, addition) {
  const output = target || createFilterStats();
  const source = addition || {};
  for (const key of [
    "recordsSeen",
    "recordsSent",
    "updatesSeen",
    "updatesSent",
    "valuesSeen",
    "valuesSent",
    "valuesExcluded",
  ]) {
    output[key] = Number(output[key] || 0) + Number(source[key] || 0);
  }
  for (const [reason, count] of Object.entries(source.excludedByReason || {})) {
    output.excludedByReason[reason] =
      Number(output.excludedByReason[reason] || 0) + Number(count || 0);
  }
  for (const [sourceId, counts] of Object.entries(source.sources || {})) {
    const current = output.sources[sourceId] || {
      updatesSeen: 0,
      updatesSent: 0,
      valuesSeen: 0,
      valuesSent: 0,
      valuesExcluded: 0,
    };
    for (const key of Object.keys(current)) {
      current[key] = Number(current[key] || 0) + Number(counts[key] || 0);
    }
    output.sources[sourceId] = current;
  }
  return output;
}

function sourceIdentityForUpdate(delta, update) {
  return firstSourceIdentity([
    update?.$source,
    update?.source?.label,
    delta?.$source,
    delta?.source?.label,
  ]);
}

function firstSourceIdentity(values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return null;
}

function sourceCatalogFromDelta(delta, catalog = {}) {
  for (const update of delta?.updates || []) {
    const sourceId = sourceIdentityForUpdate(delta, update) || "(missing)";
    const values = Array.isArray(update?.values) ? update.values : [];
    const item = catalog[sourceId] || { updates: 0, values: 0 };
    item.updates += 1;
    item.values += values.length;
    catalog[sourceId] = item;
  }
  return catalog;
}

function replayDeltaWithPolicy(delta, {
  timestamp = new Date().toISOString(),
  policy = createSourcePolicy(),
} = {}) {
  const stats = createFilterStats();
  stats.recordsSeen = 1;
  if (!delta || typeof delta !== "object" || !Array.isArray(delta.updates)) {
    return { delta, stats };
  }

  const allowedSources = new Set(policy.sensorSourceIds || []);
  const updates = [];
  for (const update of delta.updates) {
    if (!update || typeof update !== "object") continue;
    stats.updatesSeen += 1;
    const sourceId = sourceIdentityForUpdate(delta, update);
    const sourceKey = sourceId || "(missing)";
    const sourceStats = stats.sources[sourceKey] || {
      updatesSeen: 0,
      updatesSent: 0,
      valuesSeen: 0,
      valuesSent: 0,
      valuesExcluded: 0,
    };
    sourceStats.updatesSeen += 1;
    const inputValues = Array.isArray(update.values) ? update.values : [];
    sourceStats.valuesSeen += inputValues.length;
    stats.valuesSeen += inputValues.length;

    if (
      policy.mode === PLAYBACK_MODE_SENSOR_SOURCES &&
      (!sourceId || !allowedSources.has(sourceId))
    ) {
      const reason = sourceId ? "sourceNotAllowed" : "missingSource";
      stats.excludedByReason[reason] += inputValues.length;
      stats.valuesExcluded += inputValues.length;
      sourceStats.valuesExcluded += inputValues.length;
      stats.sources[sourceKey] = sourceStats;
      continue;
    }

    const values = [];
    for (const entry of inputValues) {
      if (!shouldReplayInputPath(entry?.path)) {
        stats.excludedByReason.pathNamespace += 1;
        stats.valuesExcluded += 1;
        sourceStats.valuesExcluded += 1;
        continue;
      }
      const value = refreshEmbeddedSignalKTimestamp(
        stripDerivedReplayFields(entry.value),
        timestamp,
      );
      if (isEmptyReplayValue(value)) {
        stats.excludedByReason.emptyAfterSanitizing += 1;
        stats.valuesExcluded += 1;
        sourceStats.valuesExcluded += 1;
        continue;
      }
      values.push({ ...entry, value });
      stats.valuesSent += 1;
      sourceStats.valuesSent += 1;
    }
    if (values.length) {
      updates.push({ ...update, timestamp, values });
      stats.updatesSent += 1;
      sourceStats.updatesSent += 1;
    }
    stats.sources[sourceKey] = sourceStats;
  }

  if (!updates.length) return { delta: null, stats };
  stats.recordsSent = 1;
  return {
    delta: {
      ...delta,
      updates,
    },
    stats,
  };
}

function shouldReplayInputPath(pathName) {
  const pathText = String(pathName || "");
  if (!pathText) return true;
  return !ALWAYS_EXCLUDED_NAMESPACES.some(
    (namespace) => pathText === namespace || pathText.startsWith(`${namespace}.`),
  );
}

function stripDerivedReplayFields(value) {
  if (Array.isArray(value)) return value.map(stripDerivedReplayFields);
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.entries(value).forEach(([key, child]) => {
    if (ALWAYS_EXCLUDED_NAMESPACES.includes(key)) return;
    output[key] = stripDerivedReplayFields(child);
  });
  return output;
}

function refreshEmbeddedSignalKTimestamp(value, timestamp) {
  if (Array.isArray(value)) {
    return value.map((item) => refreshEmbeddedSignalKTimestamp(item, timestamp));
  }
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.entries(value).forEach(([key, child]) => {
    output[key] = key === "timestamp" && typeof child === "string"
      ? timestamp
      : refreshEmbeddedSignalKTimestamp(child, timestamp);
  });
  return output;
}

function isEmptyReplayValue(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0;
}

module.exports = {
  ALWAYS_EXCLUDED_NAMESPACES,
  DEFAULT_SENSOR_SOURCE_IDS,
  DEFAULT_SENSOR_SOURCE_PREFIXES,
  PLAYBACK_MODE_SENSOR_SOURCES,
  PLAYBACK_MODE_STANDARD,
  SENSOR_SOURCE_POLICY_ID,
  createFilterStats,
  createSourcePolicy,
  mergeFilterStats,
  normalizePlaybackMode,
  normalizeSensorSourceIds,
  normalizeSensorSourcePrefixes,
  replayDeltaWithPolicy,
  resolveSensorSourceIds,
  shouldReplayInputPath,
  sourceMatchesPhysicalPolicy,
  sourceMatchesPrefix,
  sourceCatalogFromDelta,
  sourceIdentityForUpdate,
};
