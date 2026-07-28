# Changelog

## 0.6.2

- Report the exact capture or clip whose metadata scan failed, retain that
  failure in status without retrying on every refresh, and retry automatically
  when the file's size or modification time changes.
- Validate gzip output before replacing its plain source and before declaring a
  recomputed-result segment complete. Quarantine an unreadable pre-existing
  gzip while preserving the plain recording.
- Protect every segment in an active recomputed-result session from deletion.
- Add an explicit recomputed replay abort operation that stops injection
  immediately, finalises and preserves partial result segments, and returns an
  aborted/incomplete coverage manifest without waiting for calculation flush.
- Preserve a structured playback failure with its file, cursor, and original
  capture time in Logger status and recomputed-result summaries, and prevent a
  failed recomputed run from silently resuming.
- Expose guarded in-process playback start for Capture so starting a recomputed
  result does not depend on a second authenticated browser command.
- Replace replayed `navigation.datetime` values with the current replay
  wall-clock timestamp in every playback mode, while retaining
  `originalCapturedAt` provenance and reporting the explicit transformation.
  This prevents enabled `@signalk/set-system-time` installations from moving
  the host clock back to the voyage date while retaining the compatible
  `strict-recorded-sensor-source-allowlist-v1` selection policy ID.
- Pace replay from a monotonic clock instead of `Date.now()`, so NTP, manual, or
  sensor-driven system-time corrections cannot turn a short source interval
  into a stranded multi-day timer.

## 0.6.1

- Add strict sensor-source voyage replay that filters derived, calculated, AJRM,
  and replay output before publishing the original physical-device deltas.
- Build the allowlist and coverage index across every recording segment before
  replay, rather than inferring source type from path names or one segment.
- Lock recomputation replay to real-time speed with pause, seek, and rate
  controls disabled, isolate it from live traffic, and wait for downstream
  calculations to flush before completion.
- Reject normal capture-stop and playback-stop/restart API paths while a
  recomputed result is active, and require complete pre-indexed coverage before
  the quiet-period finalisation can begin.
- Capture every replay sensor input and recomputed output regardless of normal
  Logger `includePaths`, preventing narrowed live-capture settings from making
  an apparently complete child voyage incomplete.
- Finalise and declare every rotated recomputed-result segment in an explicit
  manifest. Final coverage is incomplete if any declared segment is missing,
  changed, or still unfinished.
- Treat configured explicit physical source IDs as live-input contamination
  matches even when that source was absent from the parent recording.

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
