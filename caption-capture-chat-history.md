# Caption capture findings from earlier investigation

Companion to [caption-capture-notes.md](caption-capture-notes.md). This file records discoveries from the earlier cross-service investigation and the implementation lessons that led to the current CDP work. Keep provider URLs/tokens redacted; downloaded sample files remain outside the repository.

Last updated: 2026-10-12

## Cross-service observations

### YouTube

- A timed-text request was observed at `https://www.youtube.com/api/timedtext`.
- A downloaded response was JSON-like YouTube timed-text data with `wireMagic: "pb3"`, `events`, `tStartMs`, `dDurationMs`, and `segs[].utf8`.
- The event data contained cue text and millisecond timing, sufficient for bulk normalization without real-time playback.
- Initial passive probe classification was `player-control`; the useful payload was found by inspecting the actual downloaded response/request, not by that classification.
- This provider JSON shape is distinct from generic JSON and should only be accepted when timed events actually contain timing plus text.

### Tubi

- A complete `.srt` file was downloaded during manual inspection. The local filename was GUID-like, but the body was ordinary SRT with absolute cue start/end times and text.
- This proves Tubi can provide a bulk timed-text artifact. It does not, by itself, prove that the extension can discover or retrieve the originating request URL.
- Extension-origin and page-world `fetch()` attempts against a candidate URL failed with `Failed to fetch`. DevTools showed the failing request initiator as `chrome-extension://...`, indicating the CORS failure belonged to the extension attempt, not necessarily Tubi's original player request.
- Tubi's initial probe classification was `unknown`, despite visible on-screen captions. The SRT was found through browser/DevTools inspection rather than native `TextTrack.cues`.
- During CDP experimentation, Tubi's caption payload was successfully captured and normalized. The same response could appear once through passive discovery and again through CDP; deduplication must preserve the CDP payload association rather than merely removing the duplicate UI candidate.

### Pluto

- Initial passive discovery returned `native-track` with track metadata and subtitle-related evidence.
- The player visibly rendered timed captions, but the exposed `TextTrack` had no usable cue list. Native extraction generated a header-only `WEBVTT` file once; this was a false success and the implementation was changed to reject empty cue lists.
- The probe was improved to report track mode, `<track>` ready state, cue count, active-cue count, source presence, and limitations. A visible player caption is not proof that `video.textTracks[].cues` contains the captions.
- Native extraction remains useful when cues are present, but Pluto's visible captions may use a player-specific rendering/network path instead.

### Amazon / Prime Video

- Initial probe classification was `player-control`, not native track. Diagnostic evidence included a subtitle menu, selected `English [CC]`, and a visible player caption/overlay such as `[rain pattering]`.
- DOM diagnostics were noisy because ancestor/page elements inherited descendant text. The presence of a control or caption-related string must not be mistaken for a timed-text body.
- A complete `.ttml2` file was downloaded manually. Its body was TTML2 XML with `<p begin="..." end="...">` timed cues, full text, line breaks, and styling spans. It is bulk-normalizable without realtime scraping.
- Earlier investigation saw Amazon's `.ttml2` request intermittently in DevTools while passive extension discovery sometimes missed it. This is why discovery must not depend solely on a post-hoc `performance` resource snapshot.
- In a later, separate investigation captured in [caption-capture-notes.md](caption-capture-notes.md), a Prime Video `.ttml2` request was confirmed as a successful direct page fetch with `credentials: 'omit'`, and CDP also captured it. Treat those as additional later observations, not evidence that all Amazon caption URLs have identical CORS/auth behavior.
- Amazon also exposed generic player-resource JSON before the timed-text request. Capture must not stop at the first JSON-looking response; accept JSON only when its body contains actual timed cue events and continue observing long enough for the later `.ttml2`/SRT response.

## Implementation lessons from this investigation

- Separate four facts in reports: a caption control exists, a native track exists, a response URL was observed, and a response body was successfully captured and parsed. They are not interchangeable.
- URL heuristics can find generic player/config resources. CDP should inspect response bodies and classify by body signature, content type, and actual timed-event structure.
- A CDP capture must be armed before reload/request replay. Attaching after the player has already downloaded the resource cannot reliably recover the response retroactively.
- Popup lifetime is incompatible with waiting on one message response across a page reload. Start capture in the worker, acknowledge promptly, retain capture state/results outside popup memory, and show explicit `starting`, `capturing`, `captured`, `no match`, and `failed` states.
- CDP candidates may duplicate passively discovered candidates by URL. Deduplication must alias the captured body to the retained candidate ID, or the body becomes unreachable even though logs say it was captured.
- Capture should not finish on generic or first-seen JSON. Amazon's timed text can arrive later than a JSON player resource; keep the capture window open and record response/body-read counters and rejection reasons.
- Empty native cue lists must not be exported as a successful header-only WebVTT. Keep the explicit empty-cue failure and diagnostics.
- Do not label native-track extraction failures as `network`. Use categories/messages that identify the failing stage.
- Signed URLs and response bodies can contain sensitive data. Console reports should redact token-like query parameters and show only short body previews when diagnosing rejected bodies.

## Suggested correction to the companion note

The current `caption-capture-notes.md` has an open-question bullet saying no Tubi capture path has been verified. The manual Tubi SRT download and later successful CDP capture documented above supersede that statement. A more accurate status is: **Tubi's complete SRT format is confirmed; exact request discovery and reliability should be confirmed against the latest CDP inventory diagnostics.**

## Current questions

- For Amazon, does the latest CDP inventory show the SRT/TTML response arriving after the generic JSON, and can the payload be retrieved through `Network.getResponseBody`?
- For each service, are duplicate passive/CDP candidates merged while retaining the CDP payload under the visible candidate ID?
- Does the worker capture lifecycle survive popup close, tab reload, extension reload, and MV3 worker suspension? In-memory maps alone are not durable across worker termination.
- Does Pluto's visible caption content ever appear in any readable response body, or does its player render from a different inaccessible pipeline?
- Which providers require no-credentials fetch, session credentials, or CDP-only response capture? Do not generalize the Prime Video no-credentials result to other resources/providers.

## Safe evidence to record

For new provider tests, record the provider/title at a high level, candidate kind/format, redacted host/path, response MIME type/status, cue count, whether timing is absolute, CDP response/body-read counts, and the resulting failure stage. Do not commit full caption payloads, signed URLs, cookies, authorization headers, or account-specific data.
