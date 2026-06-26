# AJRM Marine Logger

> **Alpha Release disclaimer:** This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

AJRM Marine Logger is a Signal K diagnostic capture and replay plugin intended for
AJRM Marine testing on a Signal K vessel server.

Version `0.5.2` expands compressed voyage replay segments into Logger's replay
cache before loading, so high-speed playback uses line offsets instead of
rescanning gzip files for every replayed delta.

Version `0.5.1` can replay lightweight AJRM Marine Capture voyage bundles that
store local capture-file references instead of embedding portable recording
segments. Logger links those local captures into its voyage replay cache when
they are available on the same Pi.

Version `1.2.7` writes an explicit journal breadcrumb when AJRM Marine Pi Controller shutdown
intent closes the active capture.

Version `1.2.6` listens for AJRM Marine Pi Controller shutdown/reboot intent and closes the
active capture and rolling buffer before the power command runs.

Version `1.2.1` updates the user-facing name to **AJRM Marine Logger** while
keeping the package id, route names, API paths, and existing `~/CapturePlusLogs`
directory stable for compatibility.

Version `1.2.0` adds voyage-bundle playback and per-file downloads. Voyage
zip files created by AJRM Marine Capture can be placed in `voyages/`, loaded
from the AJRM Marine Logger **Voyages** tab, and replayed through the contained
capture segments.

It keeps a rolling buffer of recent Signal K deltas on disk. When you press **Start Capture**, it writes a capture file that includes the configured amount of recent buffered data, then continues recording live deltas until stopped. At the end of the day you can replay captures, pause, seek, change speed, and extract a shorter clip around the problem.

## Storage

By default, AJRM Marine Logger writes to:

```text
~/CapturePlusLogs
```

The plugin creates:

- `buffer/`: rolling pre-capture JSONL segment files
- `captures/`: saved capture sessions
- `clips/`: extracted clips
- `voyages/`: zipped voyage bundles, usually created by AJRM Marine Capture

Active capture files are written as plain `.jsonl` so they remain robust while data is arriving. Completed capture files are gzip-compressed to `.jsonl.gz` by default. AJRM Marine Logger can list, replay, seek within, and extract clips from both plain and gzipped recordings without creating an uncompressed copy on disk.

Long captures are split into hourly files by default. The plugin starts a new plain file immediately, then compresses the previous completed segment in the background. When a capture or clip is closed, CapturePlus writes a small `.meta.json` sidecar beside the log with the line count and first/last timestamps, so the Logs and Clips tabs can show time ranges immediately after a restart. Older logs without sidecar metadata are indexed in the background the first time the status page sees them.

On startup, AJRM Marine Logger recovers from abrupt shutdowns before starting a new capture. It removes empty stale `.jsonl` capture files that were opened but never received data, removes incomplete `.jsonl.gz.tmp` compression files, removes incomplete metadata temp files, and compresses leftover non-empty plain capture files from an earlier shutdown or crash. The web page has an **Auto-start capture** checkbox for starting a new capture automatically when the plugin starts, useful when you want to record everything each day. Auto-start begins at the current time without pre-capture backfill so restarted unattended captures do not duplicate the previous segment; manual **Start Capture** still uses the configured pre-capture minutes. Web-page playback/capture toggles are saved in `settings.json` under the log directory. Playback can automatically continue into the next chronological recording segment in the same list, so an hourly capture can be replayed like a playlist. The web page has an **Auto-play next file** checkbox for this. Clip extraction can span these segment boundaries when the requested end time is in a later file.

The file browser has **Logs**, **Clips**, and **Voyages** tabs. Logs are full capture files; clips are named extracts; voyages are zipped bundles containing capture segments plus supporting snapshots and system data. Select one file in the list, then use the shared **Load**, **Download**, or **Delete** buttons above the list. Files can be downloaded or deleted from the browser, except for the active capture or currently loaded playback file. Loading a voyage extracts it into a replay cache and plays the capture files inside the bundle; **Auto-play next file** continues through later capture segments in that voyage.

## Install on a Pi

```bash
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-logger.git#v0.5.2 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

Open the Signal K dashboard, then open **AJRM Marine Logger** from the app list.

## Signal K security

AJRM Marine Logger is a normal Signal K webapp and should be opened from:

```text
/signalk-ajrm-marine-logger/
```

The app talks to AJRM Marine Logger through the compatibility path `/signalk/v1/api/ajrmMarineLogger/...`, so it uses the normal Signal K security model:

- status and file listings need normal read access
- capture, playback, settings, clip extraction, and delete commands need `readwrite` or `admin`
- if a control command only has read access, CapturePlus submits a `readwrite` device request; approve it in **Access Requests** and Signal K will add the browser to **Devices**
- the approved token is stored in that browser, so future CapturePlus commands do not need an admin session unless the token expires or is removed

The legacy `/plugins/signalk-ajrm-marine-logger/...` route still exists for compatibility, but Signal K admin-gates `/plugins/*`. Device approval alone does not unlock that legacy admin route.

## Behaviour

- The rolling buffer is always maintained while the plugin is enabled.
- Capture and playback are mutually exclusive, so replayed deltas are not recorded back into a capture.
- Playback publishes `plugins.ajrmMarineLogger.playback` as a replay clock so AJRM Marine can show an explicit replay badge and avoid guessing from stale timestamps. The value includes whether playback is active/playing, the recording time, file name, display file name, source kind, voyage name when applicable, and rate; speed changes are published dynamically while playback is running.
- Playback injects captured deltas back into Signal K with `app.handleMessage`.
- Capture files are newline-delimited JSON, optionally gzip-compressed once complete. Each line contains the capture timestamp and the original Signal K delta.
- Save Clip copies a named selected time range into a new JSONL file under `clips/`. Clips can be created while capture is still running, and a clip time range can span multiple hourly log files. If no individual log is selected, Save Clip searches the full log set and excludes existing clips from the source range.

## Configuration

The Signal K plugin configuration controls:

- log directory
- rolling buffer duration
- buffer segment duration
- maximum pre-capture duration
- capture file segment duration
- whether completed captures are gzip-compressed
- whether playback automatically advances to the next recording segment
- whether capture starts automatically when the plugin starts
- optional include path filters
- web status refresh interval

The default include path is `*`, which records all delta paths. Use narrower path filters when you know exactly what you need to reduce storage use.

## Development

```bash
npm install
npm test
```


## Public Beta

Signal K logging and replay utility for AJRM Marine Suite testing.

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
