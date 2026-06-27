# Changelog

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
