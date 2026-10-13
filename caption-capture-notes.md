# Caption capture notes

Shared working record of observed caption sources, capture requirements, and
open questions. Update this file as browser tests or implementation work add
evidence. Do not put signed caption URLs, account details, or caption payloads
in this file.

Last updated: 2026-10-12

## Confirmed findings

### Prime Video: FernGully

- The player requested a `{uuid}.ttml2` resource from `cf-timedtext.aux.pv-cdn.net`.
  The request appeared twice in DevTools Network during playback.
- The response was `200`, with `Content-Type: application/octet-stream`.
  Its body is TTML XML and contains timed cues, including
  `[thunder rumbling]` at approximately 00:00:12.513–00:00:14.815, followed by
  later cues such as `[rain pattering]` and `[birds chirping]`.
- `Access-Control-Allow-Origin: *` was present; no
  `Access-Control-Allow-Credentials` header was present.
- A direct `fetch(url, { credentials: 'omit' })` from the Prime Video page
  returned status 200, and the response body contained `[thunder rumbling]`.
  Therefore this particular complete caption file is readable from the page
  without CDP and without cookies.
- The service worker's CDP watcher also successfully observed the response as
  `resourceType: "Fetch"`, `contentType: "application/octet-stream"`,
  `likelyCaption: true`, read a usable caption body, detected format `ttml`,
  and created a CDP caption candidate.
- The video elements exposed no native `TextTrack` cues in our inspection.
  The player appears to render captions through its own player surface rather
  than the browser's native video text-track API.

### Extension UI and capture behavior

- Passive discovery initially showed an Amazon `playerChromeResources` URL and
  a caption-like DOM element, but not necessarily the TTML file.
- After the CDP capture completed, probing again was needed to show the cached
  CDP candidate in the popup. The user then downloaded both WebVTT and
  normalized JSON successfully.
- The popup is ephemeral and its probe displays the immediate discovery
  snapshot. The background CDP capture continues asynchronously; the popup
  does not automatically refresh when that capture completes.
- Reopening the popup alone did not restore the candidate list; probing again
  surfaced it. Candidate retrieval can start a separate CDP capture and reload
  when no captured payload is cached. If a capture is already active, another
  retrieval can report “CDP capture is already running.”
- A previous probe logged body-read failures for some unrelated responses.
  The later detailed Prime Video run did successfully capture the TTML body.
  Do not infer that every `getResponseBody` failure applies to the TTML request.

## Ways complete captions may be available

| Source/path | What it can provide | CDP required? | Evidence / limits |
|---|---|---:|---|
| Native HTML `<track>` / `TextTrack` cues | Complete cues when the track is loaded and exposes its cues | No | Supported by the content script. It may need to enable a track in hidden mode to load cues. Some players expose no native tracks. |
| Direct caption URL fetch | Complete raw file (for example WebVTT, TTML, or SRT), if the URL is known and browser fetch is allowed | No, when page fetch works | Confirmed for the Prime Video `.ttml2` URL with `credentials: 'omit'`. Current shared fetch helper uses omitted credentials. Other providers may require credentials or have different CORS policies. |
| URL found in page resource timing, `<track>`, or provider/page JSON | A candidate URL, not necessarily the response body or proof it is a caption file | No for discovery; retrieval depends on fetch access | Implemented as passive heuristics. Timing entries can be missing when a request belongs to another frame/context or is not visible in that document's performance entries. |
| CDP Network response-body capture | Full body of a response the watcher observes and can read | Yes, for this extension fallback | Confirmed to work for Prime Video's TTML response. CDP is useful when passive page discovery misses a request or ordinary page fetch is blocked. It is not inherently needed to read the Prime Video file once its URL is known. |
| Caption-like DOM overlay | At most visible/current caption text or evidence of a caption surface | No | Discovery identifies a possible DOM surface, but this is not a complete transcript and does not guarantee exact cue timings. An opt-in realtime sampler would only capture cues while sampled. |
| Player/provider JSON or manifest metadata | May identify tracks, URLs, languages, or segment layout; may sometimes contain complete text | Usually no for page-visible data; CDP may help find/read network responses | Generic page JSON discovery is implemented, but no complete caption document embedded this way has been confirmed in this project. Treat as unverified/provider-specific. |
| DRM-protected or opaque player internals | May expose no readable standalone caption body | Possibly insufficient even with CDP | No such limitation was demonstrated for the Prime Video TTML response; avoid assuming a DRM limitation without evidence. |

## What is known about the implementation

- `src/shared/utils/caption-discovery.ts` discovers native tracks, URLs in
  resource timing, caption-like URLs in selected JSON scripts, and
  caption-shaped DOM surfaces. It does not inspect network response bodies.
- `src/shared/utils/caption-fetch.ts` detects WebVTT, TTML, SRT, and JSON formats
  and fetches a known URL. In the current working tree it uses
  `credentials: 'omit'`.
- `src/entries/background/service-worker.ts` watches CDP Network responses on
  explicit caption probing/retrieval. It recognizes `.ttml2` and can also read
  generic Fetch/XHR responses to inspect candidate bodies. A recognized body
  becomes a cached candidate for popup retrieval/normalization.
- `src/entries/popup/App.tsx` presents the immediate discovery response. It
  does not subscribe to a completion update for the later asynchronous CDP
  capture.
- The current flow can therefore require multiple user actions: initial
  discovery, waiting for a capture/reload, probing again to see cached results,
  and retrieving a candidate. Starting a second capture while the first is
  active creates a confusing “already running” error.
- Background capture/candidate caches are in-memory maps. Popup reopening
  should not itself be expected to preserve UI state, and service-worker
  lifecycle may also clear those in-memory results.

## Current conclusions

1. A complete timed-text file can be obtained without CDP when the extension
   can discover its URL and a page-context fetch succeeds. This is proven for
   the observed Prime Video TTML file with credentials omitted.
2. CDP is a useful discovery/body-capture fallback, and it successfully
   captured the Prime Video file in at least one run. The previous assumption
   that the ad duration or the CDP body-read failures explained the miss was
   not established.
3. The main confirmed product issue is workflow/state: asynchronous capture
   results are not pushed back into the popup, and the multi-step interaction
   makes active/in-progress/completed capture states unclear.
4. DOM evidence is not equivalent to a complete downloadable caption source.

## Open questions / next investigation

- Why does passive discovery sometimes surface the `.ttml2` URL and sometimes
  only show the player resource URL plus a DOM surface? Check which document or
  frame owns the relevant resource-timing entry, and when discovery runs
  relative to playback/request timing.
- Can passive discovery reliably expose the URL before starting a CDP reload?
- Should known caption URL candidates be fetched directly first, using page
  context and an explicit credentials policy, with CDP only as fallback?
- How should capture state/results survive popup close/reopen and MV3 service
  worker suspension? Consider persisted state or a clear completion message,
  rather than depending on a second probe to discover background completion.
- Should CDP matching be narrowed to likely timed-text responses and report
  body-read errors explicitly, reducing unrelated body reads and ambiguity?
- Does Tubi use a native track, a directly fetchable resource, provider data,
  or another network format? No Tubi capture path has yet been verified.

## Useful test protocol

1. Keep the exact target tab active and note whether a capture/reload is
   expected.
2. In DevTools Network, preserve the log, filter to the timed-text request, and
   verify status, response content type, and one distinctive cue in the body.
3. In the extension service-worker console, inspect the same response's
   `likelyCaption`, `resourceType`, and `contentType`, then confirm whether it
   logs `usable caption body` and `Caption probe: CDP candidate`.
4. In the popup, distinguish the immediate passive-discovery list from the
   completed/cached CDP candidate list. Note each click and whether the page
   reloaded.
5. Never copy signed full URLs or full caption documents into this note.
