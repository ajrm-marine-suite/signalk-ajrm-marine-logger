# Changelog

## 0.5.3

- Compensate playback scheduling for per-delta processing time so high-speed replay catches up instead of drifting slower than the selected rate.

## 0.5.2

- Expand compressed voyage replay segments into Logger's replay cache before loading, so playback can use line offsets instead of repeatedly rescanning gzip files.
- Add a 20x playback speed option to the web app.

## 0.5.1

- Replay lightweight AJRM Marine Capture voyage bundles by linking their local referenced capture segments into the voyage replay cache.

## 0.5.0

- Initial public beta release as AJRM Marine Logger.
