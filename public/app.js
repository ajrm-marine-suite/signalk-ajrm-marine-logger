window.__ajrmMarineLoggerAppStarted = true;

const API = "/signalk/v1/api/ajrmMarineLogger";
const LOGIN_URL = "/admin/#/login";
const LOGIN_STATUS_URLS = ["/skServer/loginStatus", "/loginStatus"];
const ACCESS_REQUEST_URL = "/signalk/v1/access/requests";
const ACCESS_TOKEN_STORAGE_KEY = "ajrmMarineLogger.accessToken";
const ACCESS_REQUEST_STORAGE_KEY = "ajrmMarineLogger.accessRequestHref";
const CLIENT_ID_STORAGE_KEY = "ajrmMarineLogger.clientId";
const REQUEST_TIMEOUT_MS = 8000;

const elements = {
  banner: document.getElementById("statusBanner"),
  settingsButton: document.getElementById("settingsButton"),
  settingsPanel: document.getElementById("settingsPanel"),
  refreshButton: document.getElementById("refreshButton"),
  captureStatus: document.getElementById("captureStatus"),
  backfillMinutes: document.getElementById("backfillMinutes"),
  captureSegmentMinutes: document.getElementById("captureSegmentMinutes"),
  autoStartCapture: document.getElementById("autoStartCapture"),
  startCaptureButton: document.getElementById("startCaptureButton"),
  stopCaptureButton: document.getElementById("stopCaptureButton"),
  logsTab: document.getElementById("logsTab"),
  clipsTab: document.getElementById("clipsTab"),
  voyagesTab: document.getElementById("voyagesTab"),
  loadSelectedButton: document.getElementById("loadSelectedButton"),
  downloadSelectedFile: document.getElementById("downloadSelectedFile"),
  deleteSelectedButton: document.getElementById("deleteSelectedButton"),
  selectedFileInfo: document.getElementById("selectedFileInfo"),
  captureList: document.getElementById("captureList"),
  loadedFile: document.getElementById("loadedFile"),
  playbackTime: document.getElementById("playbackTime"),
  playbackProgress: document.getElementById("playbackProgress"),
  seekSlider: document.getElementById("seekSlider"),
  rewindButton: document.getElementById("rewindButton"),
  playButton: document.getElementById("playButton"),
  pauseButton: document.getElementById("pauseButton"),
  forwardButton: document.getElementById("forwardButton"),
  stopPlaybackButton: document.getElementById("stopPlaybackButton"),
  playbackRate: document.getElementById("playbackRate"),
  autoAdvancePlayback: document.getElementById("autoAdvancePlayback"),
  clipLabel: document.getElementById("clipLabel"),
  clipFrom: document.getElementById("clipFrom"),
  clipTo: document.getElementById("clipTo"),
  extractButton: document.getElementById("extractButton"),
  bufferStatus: document.getElementById("bufferStatus"),
  diskStatus: document.getElementById("diskStatus"),
  statsStatus: document.getElementById("statsStatus"),
  eventList: document.getElementById("eventList"),
};

let state = null;
let selectedFile = null;
let selectedKind = "logs";
let lastSelectedLogFile = null;
let activeFileTab = "logs";
let refreshTimer = null;
let draggingSeek = false;
let savingClip = false;
let accessToken = readStoredValue(ACCESS_TOKEN_STORAGE_KEY);
let accessRequestTimer = null;

window.addEventListener("error", (event) => {
  setStartupError(event.message || "CapturePlus browser script failed");
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason || {};
  setStartupError(reason.message || String(reason) || "CapturePlus request failed");
});

elements.refreshButton.addEventListener("click", refresh);
elements.settingsButton.addEventListener("click", toggleSettings);
elements.startCaptureButton.addEventListener("click", startCapture);
elements.stopCaptureButton.addEventListener("click", stopCapture);
elements.backfillMinutes.addEventListener("change", updateCaptureSettings);
elements.captureSegmentMinutes.addEventListener("change", updateCaptureSettings);
elements.autoStartCapture.addEventListener("change", updateCaptureSettings);
elements.logsTab.addEventListener("click", () => setFileTab("logs"));
elements.clipsTab.addEventListener("click", () => setFileTab("clips"));
elements.voyagesTab.addEventListener("click", () => setFileTab("voyages"));
elements.loadSelectedButton.addEventListener("click", loadSelectedFile);
elements.deleteSelectedButton.addEventListener("click", deleteSelectedFile);
elements.downloadSelectedFile.addEventListener("click", (event) => {
  if (elements.downloadSelectedFile.classList.contains("disabled")) event.preventDefault();
});
elements.playButton.addEventListener("click", play);
elements.pauseButton.addEventListener("click", () =>
  runCommand("Pause playback", () => post("/playback/pause")),
);
elements.stopPlaybackButton.addEventListener("click", () =>
  runCommand("Stop playback", () => post("/playback/stop")),
);
elements.playbackRate.addEventListener("change", updatePlaybackRate);
elements.autoAdvancePlayback.addEventListener("change", updatePlaybackSettings);
elements.rewindButton.addEventListener("click", () => nudgePlayback(-60));
elements.forwardButton.addEventListener("click", () => nudgePlayback(60));
elements.extractButton.addEventListener("click", extractClip);
elements.seekSlider.addEventListener("input", () => {
  draggingSeek = true;
  renderSeekPreview();
});
elements.seekSlider.addEventListener("change", async () => {
  draggingSeek = false;
  await seekToSlider();
});

refresh();
resumeAccessRequestPolling();

function toggleSettings() {
  const hidden = elements.settingsPanel.classList.toggle("hidden");
  elements.settingsButton.classList.toggle("active", !hidden);
}

async function refresh() {
  try {
    state = await get("/status");
    render();
    setBanner(`Updated ${new Date(state.timestamp).toLocaleTimeString()}`);
    scheduleRefresh((state.options && state.options.statusRefreshSeconds) || 2);
  } catch (error) {
    renderOffline(error);
    setBanner(
      error.message,
      true,
      error.loginUrl,
      error.loginUrl ? "Open Signal K login" : "",
    );
    scheduleRefresh(5);
  }
}

function render() {
  renderCaptureStatus();
  renderRecordings();
  renderPlayback();
  renderSystemStatus();
}

function renderCaptureStatus() {
  const recording = state.recording;
  if (document.activeElement !== elements.backfillMinutes) {
    elements.backfillMinutes.value = state.options && state.options.backfillMinutes != null
      ? state.options.backfillMinutes
      : 30;
  }
  if (document.activeElement !== elements.captureSegmentMinutes) {
    elements.captureSegmentMinutes.value = (state.options && state.options.captureSegmentMinutes) || 60;
  }
  elements.captureStatus.textContent = recording
    ? `Recording ${recording.fileName} with ${recording.lines} deltas`
    : `Buffering ${(state.options && state.options.bufferMinutes) || 30} minutes in ${(state.paths && state.paths.root) || ""}`;
  elements.startCaptureButton.disabled = Boolean(recording || (state.playback && state.playback.active));
  elements.stopCaptureButton.disabled = !recording;
  elements.autoStartCapture.checked = state.options && state.options.autoStartCapture === true;
}

function renderOffline(error) {
  elements.captureStatus.textContent = `CapturePlus status unavailable: ${error.message}`;
  elements.startCaptureButton.disabled = true;
  elements.stopCaptureButton.disabled = true;
  elements.captureList.innerHTML = error.loginUrl
    ? `<p>${escapeHtml(error.message)} <a href="${LOGIN_URL}">Open Signal K login</a>.</p>`
    : "<p>Unable to load captures.</p>";
  elements.bufferStatus.textContent = "-";
  elements.diskStatus.textContent = "-";
  elements.statsStatus.textContent = "-";
}

function renderRecordings() {
  const captures = state.captures || [];
  const clips = state.clips || [];
  const voyages = state.voyages || [];
  const rows = activeFileTab === "voyages"
    ? voyages.map((item) => Object.assign({}, item, { type: "Voyage", kind: "voyages", bundle: true }))
    : activeFileTab === "clips"
      ? clips.map((item) => Object.assign({}, item, { type: "Clip", kind: "clips" }))
      : captures.map((item) => Object.assign({}, item, { type: "Log", kind: "logs" }));
  elements.logsTab.classList.toggle("active", activeFileTab === "logs");
  elements.clipsTab.classList.toggle("active", activeFileTab === "clips");
  elements.voyagesTab.classList.toggle("active", activeFileTab === "voyages");
  elements.logsTab.classList.toggle("secondary", activeFileTab !== "logs");
  elements.clipsTab.classList.toggle("secondary", activeFileTab !== "clips");
  elements.voyagesTab.classList.toggle("secondary", activeFileTab !== "voyages");
  if (selectedFile && !rows.some((item) => item.fileName === selectedFile && item.kind === selectedKind)) {
    selectedFile = null;
    selectedKind = activeFileTab;
  }
  if (!rows.length) {
    elements.captureList.innerHTML = `<p>No ${activeFileTabLabel()} yet.</p>`;
    updateSelectedFileActions();
    return;
  }
  elements.captureList.innerHTML = rows
    .map((item) => `<div class="recording-row ${item.fileName === selectedFile && item.kind === selectedKind ? "active" : ""}">
      <button class="recording" type="button" data-file="${escapeHtml(item.fileName)}" data-kind="${item.kind}">
        <strong>${escapeHtml(item.fileName)}</strong>
        <span>${item.type}${item.compressed ? " · gzip" : ""}${item.bundle ? " · bundle" : ` · ${formatRange(item.from, item.to)} · ${formatLineCount(item)}`} · ${formatBytes(item.bytes)}</span>
        ${item.comment ? `<em>${escapeHtml(item.comment)}</em>` : ""}
      </button>
    </div>`)
    .join("");
  elements.captureList.querySelectorAll("button.recording[data-file]").forEach((button) => {
    button.addEventListener("click", () => selectFile(button.dataset.file, button.dataset.kind));
  });
  updateSelectedFileActions();
}

function activeFileTabLabel() {
  if (activeFileTab === "clips") return "clips";
  if (activeFileTab === "voyages") return "voyages";
  return "logs";
}

function selectFile(fileName, kind = activeFileTab) {
  selectedFile = fileName;
  selectedKind = kind;
  renderRecordings();
}

function updateSelectedFileActions() {
  const hasSelection = Boolean(selectedFile && selectedKind);
  elements.loadSelectedButton.disabled = !hasSelection;
  elements.deleteSelectedButton.disabled = !hasSelection;
  elements.downloadSelectedFile.classList.toggle("disabled", !hasSelection);
  elements.downloadSelectedFile.setAttribute("aria-disabled", String(!hasSelection));
  if (hasSelection) {
    elements.selectedFileInfo.textContent = `${selectedFile} · ${selectedKind}`;
    elements.downloadSelectedFile.href = downloadUrl(selectedKind, selectedFile);
    elements.downloadSelectedFile.download = selectedFile;
  } else {
    elements.selectedFileInfo.textContent = `Select one of the ${activeFileTabLabel()} below.`;
    elements.downloadSelectedFile.href = "#";
    elements.downloadSelectedFile.removeAttribute("download");
  }
}

async function loadSelectedFile() {
  if (!selectedFile || !selectedKind) return;
  await loadCapture(selectedFile, selectedKind);
}

async function deleteSelectedFile() {
  if (!selectedFile || !selectedKind) return;
  await deleteFile(selectedKind, selectedFile);
}

function setFileTab(tab) {
  activeFileTab = tab;
  selectedFile = null;
  selectedKind = tab;
  renderRecordings();
}

function renderPlayback() {
  const playback = state.playback || {};
  elements.loadedFile.textContent = playback.displayFileName || playback.fileName || "-";
  elements.playbackTime.textContent = playback.current
    ? new Date(playback.current).toLocaleString()
    : "-";
  elements.playbackProgress.textContent = playback.loaded
    ? `${playback.cursor || 0} / ${playback.totalLines || 0} deltas (${playback.lastReason || "ready"})`
    : "No recording loaded";
  elements.playButton.disabled = !playback.loaded || playback.active || Boolean(state.recording);
  elements.pauseButton.disabled = !playback.active;
  elements.stopPlaybackButton.disabled = !playback.loaded;
  elements.rewindButton.disabled = !playback.loaded;
  elements.forwardButton.disabled = !playback.loaded;
  updateClipButtonState();
  if (document.activeElement !== elements.playbackRate) {
    elements.playbackRate.value = playback.rate === "max" ? "max" : playback.rate || 1;
  }
  elements.autoAdvancePlayback.checked = !state.options || state.options.autoAdvancePlayback !== false;
  populateClipRangeFromSource();
  if (!draggingSeek) updateSeekSlider(playback);
}

function renderSystemStatus() {
  const buffer = state.buffer || {};
  elements.bufferStatus.textContent = `${buffer.currentFile || "-"} (${buffer.linesInCurrentFile || 0} deltas)`;
  const disk = state.disk || {};
  elements.diskStatus.textContent = disk.totalBytes
    ? `${formatBytes(disk.availableBytes)} free of ${formatBytes(disk.totalBytes)}`
    : disk.error || "-";
  const stats = state.stats || {};
  elements.statsStatus.textContent = `Buffered ${stats.buffered || 0}, captured ${stats.captured || 0}, filtered ${stats.filtered || 0}, played ${stats.playbackSent || 0}, compressed ${stats.compressed || 0}, next ${stats.autoAdvanced || 0}`;
  elements.eventList.innerHTML = (state.recentEvents || [])
    .slice(0, 8)
    .map((event) => `<div><strong>${new Date(event.ts).toLocaleTimeString()}</strong> ${escapeHtml(event.message)}</div>`)
    .join("");
}

async function startCapture() {
  await runCommand("Start Capture", () =>
    post("/capture/start", {
      backfillMinutes: Number(elements.backfillMinutes.value || 0),
    }),
  );
}

async function stopCapture() {
  await runCommand("Stop Capture", () => post("/capture/stop"));
}

async function updateCaptureSettings() {
  await runCommand("Save capture settings", () =>
    post("/settings", {
      backfillMinutes: Number(elements.backfillMinutes.value || 0),
      captureSegmentMinutes: Number(elements.captureSegmentMinutes.value || 60),
      autoStartCapture: elements.autoStartCapture.checked,
    }),
  );
}

async function loadCapture(fileName, kind = activeFileTab) {
  selectedFile = fileName;
  selectedKind = kind;
  if (kind === "logs") lastSelectedLogFile = fileName;
  await runCommand("Load recording", () => post("/playback/load", { file: fileName, kind }));
}

async function play() {
  await runCommand("Play recording", () =>
    post("/playback/play", {
      rate: selectedPlaybackRate(),
    }),
  );
}

async function updatePlaybackRate() {
  const playback = state && state.playback || {};
  if (!playback.loaded) return;
  await runCommand("Set playback speed", () =>
    post("/playback/rate", {
      rate: selectedPlaybackRate(),
    }),
  );
}

function selectedPlaybackRate() {
  const value = elements.playbackRate.value || "1";
  return value === "max" ? "max" : Number(value);
}

async function updatePlaybackSettings() {
  await runCommand("Save playback settings", () =>
    post("/settings", {
      autoStartCapture: elements.autoStartCapture.checked,
      autoAdvancePlayback: elements.autoAdvancePlayback.checked,
      backfillMinutes: Number(elements.backfillMinutes.value || 0),
      captureSegmentMinutes: Number(elements.captureSegmentMinutes.value || 60),
    }),
  );
}

async function nudgePlayback(seconds) {
  const playback = state && state.playback || {};
  if (!playback.loaded) return;
  const current = Date.parse(playback.current || playback.from);
  if (!Number.isFinite(current)) return;
  await runCommand("Seek recording", () =>
    post("/playback/seek", {
      capturedAt: new Date(current + seconds * 1000).toISOString(),
    }),
  );
}

async function seekToSlider() {
  const playback = state && state.playback || {};
  const target = sliderToDate(playback);
  if (!target) return;
  await runCommand("Seek recording", () =>
    post("/playback/seek", { capturedAt: target.toISOString() }),
  );
}

async function extractClip() {
  const sourceLog = lastSelectedLogFile || "";
  if (!sourceLog && !((state && state.captures) || []).length && !(state && state.recording)) {
    setBanner("Record or load a log before saving a clip.", true);
    return;
  }
  populateClipRangeFromSource();
  savingClip = true;
  updateClipButtonState();
  setBanner("Saving clip...");
  try {
    const result = await post("/clips/extract", {
      file: sourceLog,
      kind: "logs",
      label: elements.clipLabel.value || "clip",
      clipName: elements.clipLabel.value || "clip",
      from: localInputToIso(elements.clipFrom.value),
      to: localInputToIso(elements.clipTo.value),
    });
    activeFileTab = "clips";
    const clip = result.clip || {};
    const message = `Saved clip ${clip.fileName || ""} with ${clip.lines || 0} deltas`;
    setBanner(message);
    window.alert(message);
    renderRecordings();
  } catch (error) {
    const message = `Save Clip failed: ${error.message}`;
    setBanner(
      message,
      true,
      error.loginUrl,
      error.loginUrl ? "Open Signal K login" : "",
    );
    window.alert(message);
  } finally {
    savingClip = false;
    updateClipButtonState();
  }
}

function updateClipButtonState() {
  elements.extractButton.disabled = savingClip || (!((state && state.captures) || []).length && !(state && state.recording));
  elements.extractButton.textContent = savingClip ? "Saving..." : "Save as Clip";
}

function populateClipRangeFromSource() {
  const source = findClipSource();
  if (!source) return;
  const active = document.activeElement;
  if (!elements.clipFrom.value && active !== elements.clipFrom) {
    elements.clipFrom.value = isoToLocalInput(source.from);
  }
  if (!elements.clipTo.value && active !== elements.clipTo) {
    elements.clipTo.value = isoToLocalInput(source.to);
  }
}

function findClipSource() {
  const playback = state && state.playback || {};
  if (playback.loaded && playback.from && playback.to) return playback;
  const fullLogRange = findFullLogRange();
  if (fullLogRange) return fullLogRange;
  const recording = state && state.recording;
  const captures = (state && state.captures) || [];
  const sourceLog = lastSelectedLogFile || (recording && recording.fileName) || (captures[0] && captures[0].fileName);
  if (recording && recording.fileName === sourceLog) return recording;
  return captures.find((item) => item.fileName === sourceLog) || null;
}

function findFullLogRange() {
  const ranges = ((state && state.captures) || [])
    .map((item) => ({ from: Date.parse(item.from), to: Date.parse(item.to), raw: item }))
    .filter((item) => Number.isFinite(item.from) && Number.isFinite(item.to));
  if (!ranges.length) return null;
  const from = Math.min.apply(null, ranges.map((item) => item.from));
  const to = Math.max.apply(null, ranges.map((item) => item.to));
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}

async function deleteFile(kind, fileName) {
  if (!window.confirm(`Delete ${fileName}?`)) return;
  await runCommand("Delete file", () => post("/files/delete", { kind, file: fileName }));
  if (selectedFile === fileName && selectedKind === kind) selectedFile = null;
  if (lastSelectedLogFile === fileName && kind === "logs") lastSelectedLogFile = null;
}

function downloadUrl(kind, fileName) {
  return `${API}/files/${encodeURIComponent(kind)}/${encodeURIComponent(fileName)}/download`;
}

async function get(path) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders(),
  });
  return readResponse(response);
}

async function post(path, body = {}) {
  const response = await fetchWithTimeout(`${API}${path}`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const result = await readResponse(response);
  await refresh();
  return result;
}

async function readResponse(response) {
  const text = await response.text();
  const body = text ? parseJson(text) : {};
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw await ajrmMarineLoggerAccessError(response.status, body, text);
    }
    throw new Error(body.error || friendlyHttpError(response.status, text));
  }
  return body;
}

async function ajrmMarineLoggerAccessError(status, body, text) {
  const loginStatus = await readLoginStatus();
  const error = new Error(ajrmMarineLoggerAccessMessage(status, body, text, loginStatus));
  error.status = status;
  error.canRequestAccess = loginStatus && loginStatus.allowDeviceAccessRequests === true;
  error.loginUrl = LOGIN_URL;
  if (status === 401 && accessToken) {
    accessToken = "";
    removeStoredValue(ACCESS_TOKEN_STORAGE_KEY);
  }
  return error;
}

async function readLoginStatus() {
  for (const url of LOGIN_STATUS_URLS) {
    try {
      const response = await fetchWithTimeout(url, {
        cache: "no-store",
        credentials: "include",
      }, 4000);
      if (response.ok) return await response.json();
    } catch (_error) {
      // Try the next Signal K login-status route.
    }
  }
  return null;
}

function ajrmMarineLoggerAccessMessage(status, body, text, loginStatus) {
  if (body && body.error) return body.error;
  if (loginStatus && loginStatus.authenticationRequired === false) {
    return `Signal K refused CapturePlus access: ${friendlyHttpError(status, text)}`;
  }
  if (status === 403) {
    return "CapturePlus controls require Signal K read/write or admin access.";
  }
  if (!loginStatus || loginStatus.status !== "loggedIn") {
    return "CapturePlus needs a Signal K login or approved device token.";
  }
  const userLevel = (loginStatus && loginStatus.userLevel) || "non-admin";
  return `CapturePlus controls require Signal K read/write or admin access. Current user level: ${userLevel}.`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return {};
  }
}

function friendlyHttpError(status, text) {
  if (status === 401 || status === 403) {
    return "Signal K login required or this user is not allowed to control CapturePlus.";
  }
  const cleaned = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || `HTTP ${status}`;
}

function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (typeof AbortController === "function") {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const fetchOptions = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, fetchOptions)
      .then((response) => {
        window.clearTimeout(timer);
        return response;
      })
      .catch((error) => {
        window.clearTimeout(timer);
        if (error && error.name === "AbortError") {
          throw new Error(`Timed out waiting for ${url}`);
        }
        throw error;
      });
  }

  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(`Timed out waiting for ${url}`)), timeoutMs);
    }),
  ]);
}

async function runCommand(label, action) {
  try {
    return await action();
  } catch (error) {
    if (error.canRequestAccess) {
      const requested = await requestSignalKAccess(label);
      if (requested) return null;
    }
    setBanner(
      `${label} failed: ${error.message}`,
      true,
      error.loginUrl,
      error.loginUrl ? "Open Signal K login" : "",
    );
    return null;
  }
}

function authHeaders(headers = {}) {
  return accessToken
    ? Object.assign({}, headers, { Authorization: `Bearer ${accessToken}` })
    : headers;
}

async function requestSignalKAccess(label) {
  const pendingHref = readStoredValue(ACCESS_REQUEST_STORAGE_KEY);
  if (pendingHref) {
    pollAccessRequest(pendingHref);
    setBanner(
      `${label} needs write access. Approve the pending CapturePlus request in Signal K Access Requests.`,
      true,
    );
    return true;
  }
  try {
    const response = await fetch(ACCESS_REQUEST_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: getClientId(),
        description: "CapturePlus browser",
        permissions: "readwrite",
      }),
    });
    const text = await response.text();
    const body = text ? parseJson(text) : {};
    if (!response.ok) {
      const duplicate = String(body.message || body.error || text || "").includes(
        "already requested",
      );
      if (duplicate) {
        setBanner(
          `${label} needs write access. A CapturePlus access request is already pending in Signal K.`,
          true,
        );
        return true;
      }
      throw new Error(body.message || body.error || friendlyHttpError(response.status, text));
    }
    if (body.href) {
      writeStoredValue(ACCESS_REQUEST_STORAGE_KEY, body.href);
      pollAccessRequest(body.href);
    }
    setBanner(
      `${label} needs write access. Approve CapturePlus in Signal K Access Requests, then try again.`,
      true,
    );
    return true;
  } catch (requestError) {
    setBanner(`${label} failed: ${requestError.message}`, true);
    return true;
  }
}

function resumeAccessRequestPolling() {
  const pendingHref = readStoredValue(ACCESS_REQUEST_STORAGE_KEY);
  if (pendingHref) pollAccessRequest(pendingHref);
}

function pollAccessRequest(href) {
  window.clearTimeout(accessRequestTimer);
  accessRequestTimer = window.setTimeout(async () => {
    try {
      const response = await fetch(href, {
        cache: "no-store",
        credentials: "include",
      });
      const body = await response.json();
      if (body.state === "PENDING") {
        pollAccessRequest(href);
        return;
      }
      removeStoredValue(ACCESS_REQUEST_STORAGE_KEY);
      const token = body.accessRequest && body.accessRequest.token;
      if (token) {
        accessToken = token;
        writeStoredValue(ACCESS_TOKEN_STORAGE_KEY, token);
        setBanner("CapturePlus write access approved.");
        await refresh();
        return;
      }
      setBanner("CapturePlus write access was not approved.", true);
    } catch (_error) {
      pollAccessRequest(href);
    }
  }, 2000);
}

function getClientId() {
  const existing = readStoredValue(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clientId = `capture-plus-${generated}`;
  writeStoredValue(CLIENT_ID_STORAGE_KEY, clientId);
  return clientId;
}

function readStoredValue(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch (_error) {
    return "";
  }
}

function writeStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (_error) {
    // Private browsing or locked-down clients can still use an admin session.
  }
}

function removeStoredValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (_error) {
    // Ignore storage failures.
  }
}

function updateSeekSlider(playback) {
  const from = Date.parse(playback.from);
  const to = Date.parse(playback.to);
  const current = Date.parse(playback.current || playback.from);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    elements.seekSlider.value = 0;
    elements.seekSlider.disabled = true;
    return;
  }
  elements.seekSlider.disabled = false;
  elements.seekSlider.value = Math.round(((current - from) / (to - from)) * 1000);
  if (!elements.clipFrom.value) elements.clipFrom.value = isoToLocalInput(playback.from);
  if (!elements.clipTo.value) elements.clipTo.value = isoToLocalInput(playback.to);
}

function renderSeekPreview() {
  const target = sliderToDate(state && state.playback || {});
  if (target) elements.playbackTime.textContent = target.toLocaleString();
}

function sliderToDate(playback) {
  const from = Date.parse(playback.from);
  const to = Date.parse(playback.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const fraction = Number(elements.seekSlider.value || 0) / 1000;
  return new Date(from + (to - from) * fraction);
}

function scheduleRefresh(seconds) {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refresh, Math.max(1, seconds) * 1000);
}

function setBanner(message, isError = false, linkUrl = "", linkText = "") {
  elements.banner.textContent = "";
  elements.banner.append(document.createTextNode(message));
  if (linkUrl && linkText) {
    elements.banner.append(document.createTextNode(" "));
    const link = document.createElement("a");
    link.href = linkUrl;
    link.textContent = linkText;
    elements.banner.append(link);
  }
  elements.banner.classList.toggle("error", isError);
}

function setStartupError(message) {
  if (!elements || !elements.banner) return;
  setBanner(`CapturePlus cannot update the page: ${message}`, true);
  if (elements.captureStatus) {
    elements.captureStatus.textContent = "CapturePlus browser script failed. Try a hard refresh, then check Signal K login/access.";
  }
}

function formatRange(from, to) {
  if (!from || !to) return "unknown time range";
  return `${new Date(from).toLocaleString()} to ${new Date(to).toLocaleTimeString()}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatLineCount(item) {
  if (item && item.metadataPending) return "metadata pending";
  return `${(item && item.lines) || 0} deltas`;
}

function isoToLocalInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function localInputToIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
