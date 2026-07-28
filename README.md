# AJRM Marine Logger

> **Alpha Release disclaimer:** This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

AJRM Marine Logger is a Signal K diagnostic capture and replay plugin intended for
AJRM Marine testing on a Signal K vessel server.

Logger now has two explicit playback modes:

- **Standard replay** keeps the previous behaviour: it republishes recorded
  non-`plugins.*`, non-`notifications.*` paths with fresh timestamps.
- **Sensor sources only (recompute)** scans the recording's source catalogue,
  resolves configured physical-source prefixes to an exact source allow-list,
  and republishes only those recorded sensor updates. The default prefix
  `YDEN` resolves both short sources such as `YDEN.2` and long sources such as
  `YDEN.c078be001ca2785e`. Optional exact source IDs support hardware whose
  source does not use that prefix.

Exact IDs are resolved only when they actually occur in the loaded recording.
Requested IDs that are absent remain visible as **NOT RECORDED** and are not
silently treated as valid sensor input.

The resolved exact list, configured prefix/exact rules, source catalogue,
kept/excluded counts, original recording time, playback rate, and live-input
isolation status are published under:

```text
vessels.self.plugins.ajrmMarineLogger.playback
```

Source selection is based only on recorded source identity
(`update.$source`, then the documented source-label fallbacks), not path name
or numeric value. Original source identity is retained, update and embedded
timestamps are refreshed to wall time, and `capturedAt` /
`originalCapturedAt` preserve the recording clock for review.

Version `0.5.6` makes playback act as a live input simulator: raw input paths
are replayed with fresh Signal K timestamps, while derived `plugins.*` and
`notifications.*` paths are not republished into the active system.

Version `0.5.5` anchors numeric playback speeds to the source recording clock,
so 10x and 20x stay throttled when the Pi has headroom but catch up instead of
accumulating timer overhead when replay falls behind.

Version `0.5.4` adds a **Max** playback mode that uses no source-time delay and
replays as fast as the Pi can process the deltas.

Version `0.5.3` compensates playback scheduling for per-delta processing time,
so high-speed replay catches up instead of drifting slower than the selected
rate.

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

Version `1.2.0` adds voyage-bundle playback and per-file downloads. Voyage
zip files created by AJRM Marine Capture can be placed in `voyages/`, loaded
from the AJRM Marine Logger **Voyages** tab, and replayed through the contained
capture segments.

It keeps a rolling buffer of recent Signal K deltas on disk. When you press **Start Capture**, it writes a capture file that includes the configured amount of recent buffered data, then continues recording live deltas until stopped. At the end of the day you can replay captures, pause, seek, change speed, and extract a shorter clip around the problem.

## Storage

By default, AJRM Marine Logger writes to:

```text
~/AJRMMarineLogs
```

If a Pi already has recordings in the former logger directory and no explicit
log-directory setting, AJRM Marine Logger continues to use that existing
directory so upgrades do not hide earlier voyages.

The plugin creates:

- `buffer/`: rolling pre-capture JSONL segment files
- `captures/`: saved capture sessions
- `clips/`: extracted clips
- `voyages/`: zipped voyage bundles, usually created by AJRM Marine Capture

Active capture files are written as plain `.jsonl` so they remain robust while data is arriving. Completed capture files are gzip-compressed to `.jsonl.gz` by default. AJRM Marine Logger can list, replay, seek within, and extract clips from both plain and gzipped recordings without creating an uncompressed copy on disk.

Long captures are split into hourly files by default. The plugin starts a new plain file immediately, then compresses the previous completed segment in the background. When a capture or clip is closed, AJRM Marine Logger writes a small `.meta.json` sidecar beside the log with the line count and first/last timestamps, so the Logs and Clips tabs can show time ranges immediately after a restart. Older logs without sidecar metadata are indexed in the background the first time the status page sees them.

On startup, AJRM Marine Logger recovers from abrupt shutdowns before starting a new capture. It removes empty stale `.jsonl` capture files that were opened but never received data, removes incomplete `.jsonl.gz.tmp` compression files, removes incomplete metadata temp files, and compresses leftover non-empty plain capture files from an earlier shutdown or crash. The web page has an **Auto-start capture** checkbox for starting a new capture automatically when the plugin starts, useful when you want to record everything each day. Auto-start begins at the current time without pre-capture backfill so restarted unattended captures do not duplicate the previous segment; manual **Start Capture** still uses the configured pre-capture minutes. Web-page playback/capture toggles are saved in `settings.json` under the log directory. Playback can automatically continue into the next chronological recording segment in the same list, so an hourly capture can be replayed like a playlist. The web page has an **Auto-play next file** checkbox for this. Clip extraction can span these segment boundaries when the requested end time is in a later file.

The file browser has **Logs**, **Clips**, and **Voyages** tabs. Logs are full capture files; clips are named extracts; voyages are zipped bundles containing capture segments plus supporting snapshots and system data. Select one file in the list, then use the shared **Load**, **Download**, or **Delete** buttons above the list. Files can be downloaded or deleted from the browser, except for the active capture or currently loaded playback file. Loading a voyage extracts it into a replay cache and plays the capture files inside the bundle; **Auto-play next file** continues through later capture segments in that voyage.

## Install on a Pi

```bash
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-logger.git#v0.6.2 --omit=dev --no-package-lock
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
- if a control command only has read access, AJRM Marine Logger submits a `readwrite` device request; approve it in **Access Requests** and Signal K will add the browser to **Devices**
- the approved token is stored in that browser, so future AJRM Marine Logger commands do not need an admin session unless the token expires or is removed

The legacy `/plugins/signalk-ajrm-marine-logger/...` route still exists for compatibility, but Signal K admin-gates `/plugins/*`. Device approval alone does not unlock that legacy admin route.

## Behaviour

- The rolling buffer is always maintained while the plugin is enabled.
- Normal live capture and playback remain mutually exclusive. The explicit
  recomputed-replay result capture is the sole exception.
- Playback publishes `plugins.ajrmMarineLogger.playback` as a replay clock so AJRM Marine can show an explicit replay badge and avoid guessing from stale timestamps. The value includes whether playback is active/playing, the recording time, file name, display file name, source kind, voyage name when applicable, and rate; speed changes are published dynamically while playback is running.
- Playback injects captured raw input deltas back into Signal K with `app.handleMessage`, using fresh replay-time update timestamps and refreshed embedded source timestamps. Derived `plugins.*` and `notifications.*` paths are recorded for forensic use but are not republished during normal playback, so current apps recompute derived state from the replayed inputs.
- Replay preserves the physical `navigation.datetime` sensor path but replaces
  its historical scalar value with the same current wall-clock ISO timestamp
  used on the replayed update. This prevents Signal K's optional
  `@signalk/set-system-time` plugin from moving the host clock back to the
  voyage date. The transformation rule and count are explicit in the source
  policy/filter diagnostics. Playback pacing uses a monotonic clock, so an
  unrelated host-clock correction cannot strand the next replay timer.
- Sensor-only replay uses a strict, auditable allow-list resolved from the
  recording before playback. Missing, unknown, and nonmatching sources are
  excluded. The UI shows both the complete source catalogue and resolved exact
  sensor IDs before playback.
- A recomputed result capture uses no rolling-buffer backfill. It records each
  filtered replay sensor input plus newly emitted live calculated/plugin
  outputs. Normal Logger `includePaths` capture filters do not apply to this
  result stream, so a previously narrowed live-capture configuration cannot
  silently remove required sensor inputs or recalculated outputs. Logger
  playback clock/self deltas are excluded to prevent recursion.
- Recomputed result capture is locked to `1x`. Its transport cannot be
  paused, stopped, restarted, sought, or sped up while the child recording is
  active, preventing duplicated or timing-distorted input. Normal Stop Capture
  is also disabled; finalisation must use Capture's **Stop and build ZIP** after
  full coverage. Logger pre-indexes every materialised
  voyage segment before playback, forces continuation through all of them even
  when the ordinary auto-play-next setting is off, and carries one cumulative
  cursor across segment boundaries. Final metadata records per-segment and
  cumulative coverage; `coverage.complete` cannot become true after only the
  first segment of a multi-segment voyage. Long result captures may also rotate
  into multiple output files. Logger finalises them all and returns an explicit
  `resultSegments` manifest; final replay coverage remains incomplete if any
  declared result file is missing, changed, or unfinished.
- If replay fails, Logger retains a structured `playback.lastError` with the
  affected file, segment, cursor, and original capture time. A failed
  recomputed run cannot silently resume. Capture can explicitly abort it;
  Logger immediately stops injection, finalises and preserves partial result
  segments, and returns an `aborted`/incomplete manifest without the normal
  calculation quiet-time wait.
- Disable or disconnect live sensor inputs for a valid recomputation test.
  Logger quarantines physical-source deltas that arrive outside its own replay
  injection and records their source/count as a contamination warning, but it
  cannot prevent those live inputs from influencing other plugins before their
  outputs are captured. Explicitly configured physical source IDs remain part
  of this isolation check even if they did not occur in the parent recording.
- At replay end Logger keeps the result capture open until calculated output has
  been quiet for three seconds. Each newly captured output restarts that quiet
  period, with a fifteen-second maximum, so final debounced values are retained
  without allowing a noisy calculator to block finalisation indefinitely.
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

## Recompute and capture a voyage

1. Disable/disconnect live sensor feeds, restart Signal K to clear retained
   calculator state, and leave the applications whose calculations are under
   test enabled.
2. Put the parent voyage ZIP in Logger's `voyages/` directory and select it in
   the **Voyages** tab.
3. Select **Sensor sources only (recompute)**. Leave physical-source prefix
   `YDEN` for the recorded YDEN/NMEA inputs, or add the boat's explicit source
   prefix/IDs.
4. Load the voyage and verify the resolved exact source list. Stop if a required
   GPS, depth, STW, AIS, or compass source is absent.
5. In AJRM Marine Capture press **Start replay result**.
6. In Logger select `1x` and press **Play**.
7. After playback ends, press **Stop and build ZIP** in AJRM Marine Capture.

The resulting portable child voyage records its parent voyage, replay mode,
rate, source-selection policy, resolved exact sources, filter statistics,
cursor/completeness coverage, every declared rotated result segment, and the
live-input isolation result in `index.json`.

## Development

```bash
npm install
npm test
```


## Public Beta

Signal K logging and replay utility for AJRM Marine Suite testing.

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
## License and commercial use

This software is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). You may use, study, share, and modify it under that licence. If you modify it and make it available to users over a network, the corresponding source code must also be made available under the AGPL.

Commercial licensing is available by arrangement for organisations that want different terms.
