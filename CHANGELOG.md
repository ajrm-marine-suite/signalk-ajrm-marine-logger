# Changelog

## 0.5.24

- Clear the Logger playback Signal K projection when replay naturally ends or
  fails, so Display does not keep showing a stale paused replay badge during
  later live or simulated runs.

## 0.5.23

- Keep the current file list visible during a playback load if a transient
  status refresh fails, avoiding a brief misleading "Unable to load captures"
  flash while the load job is still running.

## 0.5.22

- Load recordings and voyage bundles through a pollable server-side background
  job from the web app, so long first-time voyage loads stay visibly loading
  instead of timing out and needing a second Load press.

## 0.5.21

- Show immediate loading feedback when a recording or voyage is loaded:
  disable file action buttons, change Load to Loading, and mark the Playback
  panel as loading until the replay is ready.

## 0.5.20

- Add a playback Restart button that returns the loaded recording or voyage to
  its replay start.
- Make Play restart automatically when the loaded playback has already reached
  the end, so replaying a voyage does not require a manual seek first.

## 0.5.19

- Restyle the Log/Clip/Voyage selector as folder-style tabs, separate from the
  normal file action buttons below it.

## 0.5.18

- Mark active capture recordings with `recording.active: true` in Logger status/API output so BITE and other apps can distinguish active recording from idle metadata.

## 0.5.17

- Use the global AJRM Marine Capture API registry as a fallback when preparing
  voyage downloads, so plugin start order does not silently produce lightweight
  reference-mode ZIPs.
- Fail clearly when a complete portable voyage bundle cannot be prepared,
  instead of downloading an incomplete reference-mode bundle.
- Prefix Logger voyage download filenames to make Capture, Logger, and Viewer
  downloads distinguishable during comparison testing.

## 0.5.16

- When AJRM Marine Capture is installed, use Capture's canonical portable
  voyage download builder for voyage ZIP downloads from Logger.
- Add regression coverage that clip extraction still reads gzipped capture
  segments from current voyage/capture formats.

## 0.5.14

- Replace external `unzip` archive extraction and test ZIP fixture creation
  with pure JavaScript ZIP handling, so voyage replay works on clean
  cross-platform installs and Windows CI.

## 0.5.13

- Add Signal K AppStore relationship metadata for the voyage debug mini-suite:
  Capture and Voyage Viewer.
- Add the reusable Signal K plugin CI workflow.

## 0.5.12

- Align web asset cache keys and install documentation with the package version.

## 0.5.11

- Add Signal K AppStore utility category metadata.

## 0.5.10

- Rename remaining Logger UI, device, status, and storage defaults to AJRM Marine naming while retaining legacy-directory compatibility on upgraded Pis.

## 0.5.9

- Update Voyage Viewer sidecar regression fixtures to the AJRM Marine plot-cache suffix.

## 0.5.8

- Add a configurable voyage replay warm-up window, defaulting to seven minutes, so normal replay primes AIS/static data without replaying the whole debug backfill.
- Add a full-backfill replay option for debugging voyages from the earliest bundled capture record.
- Publish voyage start and warm-up status on the Logger playback clock for downstream apps.

## 0.5.7

- Materialise compressed `.jsonl.gz` captures into Logger's replay cache before
  playback, so direct capture replay uses line offsets instead of repeatedly
  rescanning gzip streams.

## 0.5.6

- Replay raw input paths as live-looking Signal K data with fresh update and embedded source timestamps.
- Stop republishing derived `plugins.*` and `notifications.*` paths during playback, while still recording them for forensic debugging.

## 0.5.5

- Anchor numeric playback speeds to the source recording clock so high-speed replay catches up when it falls behind instead of accumulating timer overhead.
- Keep Max as the no-delay mode, while 10x and 20x remain throttled when the Pi has enough headroom.

## 0.5.4

- Add a Max playback mode that uses no source-time delay and replays as fast as the Pi can process the deltas.
- Add the Max option to the web playback speed selector.

## 0.5.3

- Compensate playback scheduling for per-delta processing time so high-speed replay catches up instead of drifting slower than the selected rate.

## 0.5.2

- Expand compressed voyage replay segments into Logger's replay cache before loading, so playback can use line offsets instead of repeatedly rescanning gzip files.
- Add a 20x playback speed option to the web app.

## 0.5.1

- Replay lightweight AJRM Marine Capture voyage bundles by linking their local referenced capture segments into the voyage replay cache.

## 0.5.0

- Initial public beta release as AJRM Marine Logger.
