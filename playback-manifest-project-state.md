# Playback manifest discovery and processing: project state

Last updated: 2026-10-15

## Purpose

Develop an evidence-driven, cross-service strategy for tracking
content-relative playback time independently of inserted advertisements, so
timestamped content tags can later be interpreted reliably. Manifest
discovery and interpretation remain useful supporting evidence for the media
timeline and caption alignment, but the first runtime solution should work
from ordinary page behavior without depending on manifest access.

The investigation used a one-click **Playback Trace** that can be
started on a service tab before the extension has discovered a video element.
Some services may begin with an ad as soon as the player/video becomes
available, so video discovery must not be a prerequisite for arming capture.
The trace should then run unattended for a full test movie and leave a
bounded, locally reviewable record for later analysis rather than requiring
someone to watch the browser or stream raw network events into a chat. For
these experiments, the expected maximum movie duration including ads is 150
minutes; reaching that limit should stop and finalize the trace exactly as if
the user had clicked Stop.

Broad additional capture and manifest-discovery work is paused. The current
focus is to turn the evidence already gathered into a non-CDP, behavior-driven
content playhead and progressive ad indicators, as described below.

This is an exploration note, not a claim that the extension currently parses
manifest timing semantics or identifies ads automatically. It can retain
bounded, structurally validated, sanitized DASH/HLS manifest text for
inspection. Record observations as **confirmed**,
**disproven**, or **unknown**. Keep provider-specific details separate from
cross-service conclusions.

## Product goals

The next product capability is an ad-independent, content-relative playhead
that can later drive timestamped content tags. Design and implementation
should prioritize these goals in order:

1. Maintain an internal content playhead updated to one-tenth-second
   resolution. It should represent how far into the movie's content playback
   is, excluding inserted ad time whenever observable behavior permits. Do
   not select rules based on service or platform identity; use observed video
   elements, playback state, duration changes, time progression, transitions,
   and other generic signals.
2. While the popup is open, display the playhead and total movie duration in
   a row immediately above the buttons. The left side uses
   `[00:0]0:00.0 / [00:0]0:00`: current content position to tenths of a
   second, then total content duration to whole seconds. Hours expand as
   needed; the display must not imply that an ad-inflated player duration is
   the movie's content duration. Keep the timer live while the popup remains
   open.
3. Provide a user-invoked **Export analysis** action that produces a
   shareable diagnostic document explaining what the extension observed, how
   it interpreted those observations, the conclusions and confidence levels,
   and the evidence/reasoning behind them. It should help diagnose unexpected
   timer or ad behavior without requiring a raw playback trace or another
   person to reproduce the session.
4. Detect when an advertisement is playing from observable behavior, without
   provider identification.
5. When ad playback is detected, show `Ad` right-aligned in that timer row.
6. When possible, estimate the remaining time in the current ad block. A
   block may contain multiple ads; do not confuse the active ad's remaining
   duration with the whole block's remaining duration.
7. When block time is known, show `[0]0:00` immediately after `Ad` in the
   same right-aligned element.
8. When possible, estimate how long remains before the next ad begins while
   content is playing. This is optional and may require player-exposed
   schedule clues.
9. When that estimate is available, show `[00:0]0:00` as a right-aligned
   countdown in the timer row.

All timing and classification must be possible from ordinary extension/page
observations without attaching the debugger or entering CDP mode. One decimal
place is a display/update resolution, not a promise of 100 ms measurement
accuracy. Preserve uncertainty internally; when evidence is insufficient,
prefer an unavailable value to a falsely precise timer or ad label.

Related context: [caption-capture-project-state.md](caption-capture-project-state.md)
records the caption-discovery work and current provider evidence. YouTube,
Prime Video, and Tubi have a user-confirmed caption discovery, retrieval, and
normalization path. Pluto remains unresolved, with evidence pointing to
segmented subtitles and a Shaka text track.

## Why manifests matter to captions

Captions may be delivered as standalone files, in timed-text segments, or
through player/native tracks. A player may insert ads into the playback
timeline, so a caption cue's position cannot safely be interpreted as
program-relative without understanding the stream's periods, segments,
discontinuities, and any ad transitions. A complete caption workflow may need
to determine whether a cue belongs to program content, an ad, or an
unclassified portion of playback.

Manifest interpretation may help design a reliable Pluto caption strategy
and can provide supporting timing evidence across services. It is not a
prerequisite for the initial content-clock feature. The approach must not
assume that all providers expose ads in the same way, that a manifest is
always accessible to the page, or that every manifest marker unambiguously
identifies an ad.

Efficient experiments also need a causal timeline. A user may seek forward to
trigger an ad, while the seek itself or the resulting downloads and player
events can resemble an automatic ad transition. Trace records should make
user interventions visible and time-correlated with playback/network events,
without claiming causality from correlation alone.

## Strategy

Treat the requested playhead as a normalized **content clock**, distinct from
any individual media element's `currentTime`, the wall clock, or the player's
reported duration. Use a small shared state model rather than a service
classifier:

- **Candidate media:** Observe all accessible `<video>` elements and their
  current time, duration, paused/ended state, playback rate, dimensions,
  visibility, source changes, and events. Rank likely active presentation
  media using several signals together: visible rendered area, nonzero
  duration, recent time progression, audible/playing state, and whether other
  candidates are paused or tiny. A small preview video should not win just
  because it is playing. Re-evaluate as elements appear, disappear, or swap
  roles. Keep the chosen element provisional when evidence conflicts.
- **Content clock:** When the selected element is confidently carrying
  content and its media time is a reliable content timeline, follow that time
  and round only for display. Otherwise maintain a monotonic accumulated
  content clock from observed elapsed playback, excluding intervals
  classified as ads. Pause it while content is paused or buffering; re-anchor
  it on a seek, source replacement, or timeline discontinuity rather than
  blindly adding wall time. Track seek origin as unknown unless a trusted
  interaction or explicit player signal supports an attribution. Never
  silently treat a large jump as ordinary playback.
- **Duration baseline:** Maintain a history of each candidate's duration and
  source/lifecycle. A stable duration observed before an insertion can be a
  candidate content-duration baseline. If the same element's duration later
  grows while playback resets or switches to an ad, the increase is evidence
  of inserted duration, not proof by itself. Conversely, if a separate short
  ad element appears while the main element pauses and retains its duration
  and time, keep the main content clock frozen and treat the ad as a separate
  clock. If the first observation already includes an ad or the title is
  resumed, do not infer the clean content duration by guessing. Show total
  duration only when it can be separated credibly from ad time.
- **Transitions and confidence:** Represent observations such as
  `content`, `possible-ad`, `ad`, and `unknown` with confidence and evidence
  provenance. Combine independent clues; do not promote one weak clue to a
  definite classification. Clear/reassess state after seek, source change,
  page navigation, or active-element replacement. Preserve enough recent
  transition history to avoid confusing a paused background/preview with the
  current movie.

### Behavioral heuristics

Prefer direct, generic observations first:

1. **Strong evidence for an ad:** A visible active player/video explicitly
   labeled `Ad` or `Advertisement` in accessible text/ARIA; an exposed
   skippable-ad control; or a short-lived active video that replaces/overlays
   the main content while the content element pauses or holds its playhead.
   Combine the cue with a coherent transition into and out of the interval.
2. **Useful supporting evidence:** Abrupt change in selected media element,
   source, duration, or timeline; a short duration followed by a reset to the
   longer-lived content element; content time held constant while another
   element advances; or a sudden duration increase aligned with a playback
   reset. These are clues, not service-independent proofs: previews, trailers,
   chapter transitions, seeking, and source rebuffering can resemble them.
3. **Weak evidence only:** A duration jump alone, a sudden time discontinuity,
   a cluster of requests, or a long pause. Do not label an ad from any one of
   these. Request metadata may be unavailable without CDP and ad-decision
   calls can occur when no ad is served.
4. **When signals disagree:** Mark the interval `unknown` or `possible-ad`,
   avoid subtracting unconfirmed time from the content clock, and retain the
   raw observed media time separately. A visible timer can show the best
   content-clock estimate while internal confidence makes limitations
   explicit; if the estimate is not meaningful, use an unavailable display
   instead of fabricating precision.

### Explainable analysis and export

Treat the diagnostic report as an explanation of the runtime model, not a
dump of everything the browser observed. The implementation should retain a
bounded, privacy-minimized evidence ledger for decisions that affect the
content clock or ad indicators. For each meaningful transition or estimate,
record:

- The conclusion (for example, selected content element, content-relative
  position, possible/confirmed ad state, block time remaining, or unknown).
- The observed facts that informed it: relative timestamps, media time and
  duration before/after, paused/playing state, source or element changes,
  visible/accessibility clues, and relevant seek/reset transitions.
- The inference rule or concise reason applied, including which signals were
  considered strong, supporting, or weak.
- Confidence as a clear qualitative level (high/medium/low/unknown) with a
  short rationale. Do not imply calibrated statistical probability unless
  there is evidence for one.
- Competing explanations, missing observations, and why a value was accepted,
  downgraded, or left unavailable.

The exported document should present a readable summary first, followed by a
compact chronological sequence of evidence and interpretations. Include the
content-clock estimate and any ad/countdown state at key transitions, plus
the current reasoning version so reports from different iterations can be
compared. Keep enough provenance to reproduce the calculation, but omit
unrelated DOM data, arbitrary page text, full network traces, response bodies,
signed URLs, tokens, cookies, account/title details, and raw user input.
Prefer relative elapsed times and normalized event labels. The user explicitly
invokes export and can inspect the document before sharing it; exporting must
not transmit it automatically. The report should state that its conclusions
are heuristic, identify gaps, and distinguish directly observed facts from
inferences.

An implementation can keep the ledger in memory during active playback and
bound its event count/retention window. Export need not include every
per-frame time update: summarize stable intervals and retain detailed
evidence around state changes, seeks, source changes, and confidence changes.
This keeps the report useful without creating another unbounded playback
trace. The report is a planned diagnostic feature, not implemented behavior.

### Ad-block and next-ad estimates

- For one active ad, remaining time can be estimated from its duration minus
  its current time, provided the element is actually the ad and its duration
  is stable. This is only the active ad's remaining time.
- For a multi-ad block, prefer a visible generic player countdown or
  accessible label that explicitly says how much time remains in the ad
  break. If the player exposes a total block duration or a complete schedule
  through accessible page state, that may also support a countdown. Do not
  assume that summing current/known ad durations gives the full pod: later ads
  may not yet be loaded, and skipped ads change the remaining time.
- Before the next ad, only show a countdown when an observable player cue
  provides a future boundary and a usable relation to the content clock. A
  visible timeline marker, accessible schedule, or a parsable manifest
  boundary may be a candidate. Merely seeing an ad-related request or an
  earlier average interval is not enough. Otherwise leave this optional
  indicator absent.
- Render each optional estimate only while its evidence remains current.
  Discard/recompute after a skip, seek, ad transition, duration change, or
  source replacement. Do not let a countdown continue through a state change
  as if it were authoritative.

### Non-CDP observation and separately retrievable data

The runtime path should rely first on ordinary content-script observations:
video element properties/events, visibility and layout, accessible labels and
controls in the page DOM, native text tracks, and normal extension messages
that keep popup state fresh. A content script can also inspect
`PerformanceResourceTiming` for resource names/timing when exposed, but this
reveals metadata, not response bodies, and cross-origin detail may be
restricted. Do not add CDP-only dependencies to the playhead/ad logic.

Some data may be retrievable separately, analogous to caption retrieval, if
the page exposes a resource and existing extension permissions and browser
access rules allow it:

- Text tracks or subtitle files (for example WebVTT, TTML, or segmented
  captions), useful for later alignment with the content clock.
- DASH MPDs or HLS playlists when an accessible resource URL and permitted
  fetch path are available; sanitized timing/period/segment structure may
  provide useful boundaries, but the file need not identify ads reliably.
- Small, explicitly filtered player/configuration or schedule metadata, but
  only when a response can be fetched through a supported non-CDP path and
  reduced to safe fields. Do not retain a full watch response, signed URL,
  token, media body, or arbitrary API payload for this feature.

Page-visible DOM or accessible labels are the most promising generic source
for current ad and pod countdowns. Native video properties are the most
promising baseline for current content position. A separately fetched
manifest or caption file is supporting evidence, not a prerequisite. If the
browser does not expose a response body without CDP, do not attempt to bypass
CORS or extension permissions; the feature should degrade gracefully.

### Experiments and calibration

Pause additional data gathering for now. When implementation begins, use the
existing captures as offline behavioral cases and add deterministic tests for
the state model: one main video, a tiny moving preview, separate ad video
with content paused, same-element duration expansion, ad-first observation,
resume into saved progress, seek during content, skip during an ad, buffering,
and ambiguous source/duration changes. Verify that only confirmed ad
intervals are excluded from content time and that the clock does not drift
while paused or buffering.

For later live fine-tuning, collect short, targeted, no-CDP checks only where
a specific uncertainty remains. Compare the displayed tenth-second clock to
the player/content position before, during, and after an ad; test titles with
and without resume progress; try both separate-element and same-element
transitions; and compare visible ad/pod countdowns to measured wall time,
including skipped ads. Record false positives and false negatives as well as
successful detection. Do not restart broad manifest discovery unless those
tests expose a concrete gap that cannot be handled by ordinary page
observations.

## Current evidence

### Confirmed

- Caption discovery, retrieval, and normalization are user-confirmed for
  YouTube, Prime Video, and Tubi, as described in the related project note.
- A YouTube Playback Trace ran for about 36 seconds after the user armed it
  and clicked a previously watched movie. The player first exposed the movie's
  7,165.167-second duration (1:59:25.167) and sought to 7,001 seconds
  (1:56:41), consistent with resuming near the end of the movie. Before that
  saved position played, the player state reset through `emptied`/`loadstart`
  and reported an ad duration of 28.081 seconds. The trusted button click was
  recorded at an ad media time of about 15.70 seconds; within about 150 ms,
  playback state reset again, and the movie returned at 7,001 seconds.
  This aligns with the user's report that the click was Skip and that the
  movie resumed near the final credits. The same reported movie duration
  returned, so this trace does not show an ad duration being added to the
  movie's duration. The pre-ad seek to the saved position and post-ad return
  to that same position make resume behavior a key confounder when comparing
  ad timing with the film timeline.
- YouTube network metadata around this transition includes a successful
  `youtubei/v1/player/ad_break` request/response, advertising measurement
  requests, `googlevideo.com/videoplayback` traffic (including a response
  typed `application/vnd.yt-ump`), and successful `api/timedtext` requests
  both around the ad startup and after Skip. These records support using
  provider/player signals and playback state alongside manifest evidence.
  They do not establish which media request carried the ad, what the timed
  text contained, or whether captions were shown during the ad.
- No DASH or HLS manifest was captured in this YouTube trace, and it retained
  no response bodies. The observed YouTube playback request/signaling path
  therefore cannot yet be interpreted as a manifest timeline; the absence of
  a captured manifest does not prove that YouTube used no manifest or
  equivalent stream description.
- In a second YouTube trace, the user again opened a previously watched movie.
  The player reported an initial 15.041-second ad timeline, then a separate
  75.361-second ad timeline. The user reports that the first ad was
  non-skippable and skipped the second as soon as Skip became available. The
  trusted button click was recorded with the ad video's current time at about
  6.44 seconds; the next player reset was followed by the movie loading and
  seeking to 314 seconds (5:14), then playing from there. This is consistent
  with an opening two-ad sequence before resuming saved movie progress; the
  trace does not record the saved position before the ads, so it cannot show
  whether the ads affected that position.
- That trace includes a successful `get_watch` response but no captured
  `youtube_ad_response_summary`: the capture was skipped as
  `response-over-size-limit`. The recorded encoded transfer length was
  143,154 bytes, but the skip event does not say whether a larger
  `Content-Length` value or another size measurement triggered the 512 KiB
  pre-read guard. No `/youtubei/v1/player/ad_break` request appears in this
  trace. Consequently, this ad-bearing run provides no response-body evidence
  about eligibility, ad selection, or scheduled timing; the pair of ad
  durations is observed from player state, not a manifest or response
  summary.
- A Tubi Playback Trace ran for 13 minutes 5 seconds. The user armed it on the
  home screen, clicked a movie in the carousel, and captured playback on the
  resulting page without reloading the whole page after arming. The movie
  began at media time zero with no preroll ad. Its player duration was
  8,239.963 seconds (2:17:19.963), matching the user's displayed
  02:17:19.
- Five sanitized HLS manifests were captured shortly after the carousel
  click: one master playlist and four media playlists. The master lists
  multiple video renditions and an audio group. The media playlists are VOD
  playlists with roughly 1,373-1,374 byte-range segments; their summed
  `EXTINF` durations are 8,239.963-8,239.965 seconds, matching the movie
  duration. None contains `EXT-X-DATERANGE`, cue/SCTE tags, or
  `EXT-X-DISCONTINUITY`. In this trace, the captured HLS playlists therefore
  describe the full movie timeline without an explicit ad-break marker.
- At elapsed 669.90 seconds, when the main movie's media time was 664.432
  seconds (about 11:04), the main video paused. A second video element was
  discovered and played five sequential clips with reported durations
  15.019, 30.037, 30.251, 15.019, and 15.019 seconds, totaling 105.345
  seconds. The trace then shows the ad video ending and the movie resuming at
  664.432 seconds, with its 8,239.963-second duration unchanged. This is
  strong evidence that this Tubi break was played in a separate video element
  outside the movie's media-time timeline, unlike Pluto's ad periods embedded
  in its stitched MPD. The ad clips' UI behavior and distinct media host also
  match the user's observation that the ads played as a sequence. A nearby
  Tubi JSON request may relate to the ad transition, but its response body
  was not captured and its role is unknown.
- No caption-specific requests or subtitle rendition appeared in this Tubi
  trace. Since the user did not check or change caption settings, this does
  not establish whether captions were enabled or whether Tubi captions would
  continue through this separately played ad sequence.
- The captured Tubi HLS `EXT-X-KEY` tags included a DRM `KEYID` value. A key
  identifier is not a decryption key, but should be treated as sensitive
  metadata and not shared unnecessarily. The earlier HLS sanitizer redacted
  key URIs but missed this attribute; future traces now redact `KEYID` while
  retaining non-secret key-format identifiers. This Tubi artifact predates
  that fix; avoid sharing it and delete it when no longer needed.
- Pluto playback has produced successful `200` responses for paths shaped
  like `/dash/.../text/en-cc/<segment>.m4s`, with MIME type
  `video/iso.segment`, alongside audio and video segment requests.
- Pluto exposes a Shaka `TextTrack` whose cue list changes during playback.
  Snapshots suggest a moving cue window; reading the track only once may miss
  earlier cues.
- A Pluto Playback Trace ran for 3 minutes 46 seconds while its small preview
  video was already playing. The user clicked Play after tracing began; there
  were no preroll ads, and the movie began after a short buffering period.
  The video element first reported an epoch-like media time with zero
  duration, then reset through `emptied`/`loadstart`; the movie subsequently
  reported a stable duration of 8,577.388 seconds. This is consistent with
  the preview and movie being different playback states, but the trace does
  not identify the preview stream's role.
- In the Pluto trace, two trusted clicks on caption-setting controls were
  recorded with the movie at about 29.9 seconds and caused no seek. At about
  66 seconds, a trusted click on the timeline sought from about 54 seconds to
  5,992 seconds (about 1:39:52). The player then showed the user-observed
  multi-ad break; Pluto's UI displayed per-ad progress and a pod-wide
  remaining-time countdown, indicating that it knew a total for the ad
  collection when the break began.
- Around that timeline seek and reported ad break, the trace recorded a
  cluster of ad measurement/tracking requests to multiple ad-tech endpoints.
  Caption requests also switched from the initial DASH path range to other
  ranges: a later fragment in one range and initialization/first fragments in
  another were requested near the seek, followed by later caption fragments
  during the break and after the player repositioned. This shows timed-text
  requests continue around the ad transition and that the fetched segment
  sequence/ranges change. Since the trace retains request metadata only, it
  cannot establish whether those captions are for program content, ads, or
  both.
- The Pluto player time advanced from about 5,992 seconds after the user seek
  to about 6,142.8 seconds near the end of the captured ad run. At about
  218 seconds elapsed, it then emitted another `seeking`/`seeked` transition
  to about 6,444.1 seconds, without a corresponding page click. No duration
  change was recorded. This automatic ~301-second media-time jump is evidence
  of a discontinuity or reposition around the post-ad transition; its cause
  and whether this media clock represents stitched time or program time
  remain unknown. The user's hypothesis is that the timeline click targeted a
  later content position but Pluto first sought to the ad breakpoint at 5,992,
  played the approximately 145-second pod (the clock advanced about 151
  seconds to 6,142.8), then automatically sought to 6,444.1, the content
  position corresponding to the user's click after the scheduled break. The
  observed order and elapsed/media-time differences are consistent with that
  explanation, but the click event has no requested target time and the trace
  does not reveal Pluto's timeline mapping; treat this as a plausible
  hypothesis, not a confirmed interpretation.
- The Pluto player requested its stitched DASH `main.mpd`, which returned
  HTTP 200 as `application/dash+xml`. The transfer encoded size was about
  39 KB, but the decoded response exceeded the 256 KiB per-manifest
  retention limit, so the trace records `manifest_capture_skipped` and
  retains no MPD body. Thus this run confirms the manifest's existence but
  not its periods, ad markers, or timing structure. The observed duration
  remained 8,577.388 seconds through the ad break.
- A second Pluto trace was started without refreshing the page. A video was
  already present at about 27.3 seconds; the user's Play click was followed
  by `emptied`/`loadstart`, a reset to zero, and playback startup. The
  8,577.511-second movie duration and its MPD were captured after that
  transition. The user did not open the caption controls in this run, so the
  trace provides no evidence about whether captions were enabled or displayed.
- The second Pluto trace retained the sanitized 270,781-byte static DASH MPD
  under the new 1 MiB per-document limit. Its 82 Period durations sum to the
  declared 8,577.511-second presentation duration. Sixty-nine short periods
  carry the same `InbandEventStream` descriptor (its `schemeIdUri` is
  currently redacted, with `value="999"` retained); they total 1,649.545
  seconds. The other 13 periods total 6,927.966 seconds and include the long
  program portions. Text/caption AdaptationSets occur in the long periods
  without that descriptor, not in the short periods with it. Here, “marked”
  and “unmarked” are informal shorthand for the presence or absence of this
  descriptor; they are not DASH terms, and a DASH Period is not inherently an
  ad or a movie segment. Under the working assumption that descriptor-bearing
  periods are ad segments, they form 11 contiguous runs that are plausible ad
  pods. A run consists of several marked Periods and lasts about 150 seconds;
  it should not be described as one individual ad. The descriptor's
  identifying scheme is hidden by URL sanitization, so its ad semantics are
  not yet independently verified.
- If those 11 runs are treated as ad pods and the remaining periods as
  program, the static MPD is sufficient to calculate their expected
  presentation-timeline placement and duration from each Period's `start`
  and `duration`. The schedule below uses elapsed `HH:MM:SS.sss` offsets from
  the start of the MPD presentation, which includes earlier ad time. This is
  now the working hypothesis for investigation: the repeated descriptor
  distinguishes ad-serving periods, and each contiguous run is one pod. The
  extension's intended analysis needs pod-level boundaries and duration, not
  identification or parsing of individual ads within a pod:

  | Candidate pod |    Starts at | Scheduled duration |
  | ------------- | -----------: | -----------------: |
  | 1             | 00:20:25.800 |          150.757 s |
  | 2             | 00:31:22.124 |          150.159 s |
  | 3             | 00:41:24.316 |          146.189 s |
  | 4             | 00:54:08.605 |          150.331 s |
  | 5             | 01:05:08.603 |          150.621 s |
  | 6             | 01:15:33.824 |          150.294 s |
  | 7             | 01:25:23.718 |          150.322 s |
  | 8             | 01:39:53.040 |          150.096 s |
  | 9             | 01:49:56.336 |          150.392 s |
  | 10            | 02:03:35.228 |          150.058 s |
  | 11            | 02:14:05.252 |          150.326 s |

  Together, those runs total 1,649.545 seconds (27:29.545) of scheduled
  candidate pod time within the 8,577.511-second (2:22:57.511) presentation.
  This is the schedule encoded by this captured MPD under the working
  hypothesis, not a guarantee that every pod or ad will be served or played
  in a later session.

- At elapsed 106.17 seconds, the user's timeline click was followed by a
  seek to media time 7,415 seconds. The MPD has a marked period boundary at
  7,415.228 seconds, only about 0.23 seconds later. Seven consecutive
  marked periods span 7,415.228-7,565.286, totaling 150.058 seconds, after
  which an unmarked program period begins. Near elapsed 259.46 seconds, the
  player automatically sought from 7,565.641 seconds—about 0.36 seconds
  into that post-ad program period—to 7,797.364 seconds. That transition
  occurred about 150.7 seconds after the user seek completed. The alignment
  of click/seek, marked-period start, ad-pod duration, and post-ad boundary
  strongly supports the hypothesis that Pluto first snaps a late timeline
  seek to the ad breakpoint, plays the scheduled pod, then jumps forward to
  the intended content location. The exact intended click target is not
  captured, so this remains a well-supported hypothesis rather than proof.
- Caption requests in the second trace used the long program-period ranges:
  the pre-break range's late fragment was requested near the timeline click,
  a following range's initialization/first fragment was requested as the
  ad break began, and later fragments were requested around the automatic
  post-ad seek. This is consistent with the MPD's caption tracks being tied
  to program periods, potentially including prefetching across the break.
  No caption track appears in the marked ad periods, but this alone cannot
  establish whether ads had separately rendered captions or whether any
  captions were visible.
- One Amazon playback trace captured a visible ad break and direct
  ad-specific network evidence. A trusted page click was followed by an
  Amazon ad-decision request, separate DASH manifests on an ad-delivery host
  with `/interstitial/` paths, and audio/video MP4 initialization and segment
  requests. The main video's reported duration increased by 161.161 seconds
  at the same time the first ad manifest was requested. This strongly supports
  an inserted ad sequence, but does not by itself reveal the MPD timeline or
  prove that each requested manifest represents a separate ad.
- The Amazon trace began with the main video already discoverable and playing
  at about 3.3 seconds. It therefore validates capture during an active
  session, not capture from before player startup or completeness of the
  startup manifest sequence. A second, paused 31.2-second video element was
  also discovered; its role is unknown.
- In that Amazon trace, the main video element's media time advanced
  monotonically through the observed break; the trace did not show a clear
  media-time reset or discontinuity at the ad transition. The duration change
  and ad-specific requests are better evidence of the break than media time
  alone.
- The trace recorded a trusted page click and subsequent seek lifecycle
  events, but failed to retain a useful pre-seek media time. The last
  time-sample before the click was about 15 seconds earlier, while the click
  and seek events already reported the new position. This trace therefore
  cannot establish the exact seek delta or prove the click caused that seek.
- A second Amazon trace ran for 2 minutes 44 seconds, was armed before the
  movie started. The user observed an initial sequence of ads before movie
  playback; the trace began with two video elements at zero time. It recorded
  early DASH-host `text/xml` traffic and, after the user's later timeline
  click, another ad break: the main video duration increased by about 17
  seconds, and a separate ad-host MPD response arrived alongside interstitial
  media requests. The trace had no bodies, so the early XML document's format
  and the later MPD's period/timeline structure remain unconfirmed.
- A third Amazon trace ran for 4 minutes 21 seconds and captured ten DASH
  MPDs. An Amazon `getVideoAds` request and response were recorded about
  2.8-3.5 seconds after trace start, well before the user's later seek; a
  second such request appeared around the eventual break. This is consistent
  with the player's early ad-break awareness and timeline dot, but the JSON
  response body was not captured, so the data it supplies is unknown. Before
  the later ad break, the main media element reported 4,560
  seconds (76 minutes), matching the first corrected content MPD's declared
  duration of 20:14.922 plus a subsequent corrected MPD duration of 55:45.078:
  together, exactly 76 minutes. At the break, player duration increased to
  4,721.161 seconds, an increase of 161.161 seconds. Eight captured
  interstitial MPDs had declared durations totaling about 161.355 seconds.
  This close match strongly supports the idea that duration increase tracks
  ad time inserted into the player timeline in this session. The MPDs each
  describe one static period; summed declared durations do not prove that
  every rendition was actually played. The user confirms that the roughly
  20-minute content MPD corresponds to the movie portion before the single
  visible mid-roll break, and the roughly 55-minute MPD to the remaining
  content after it. This gives the two MPDs a concrete relationship to the
  program around the break: they appear to describe the two content portions
  on either side of the inserted ad interval, rather than two unrelated
  alternate versions. Their durations sum to the 76-minute content baseline.
- Comparing the same title across captures shows the initial 4,560-second
  duration recurring when tracing before the observed mid-roll insertion
  (first and third captures). In the run where preroll ads played first, the
  first observed main-video duration was already 4,622.062 seconds, 62.062
  seconds above that baseline; it later increased by 17.017 seconds to
  4,639.079. This is consistent with duration already including preroll time
  before the first video-duration observation, but the older trace did not
  capture manifest bodies and cannot confirm when or why the baseline was set.
- A fourth Amazon trace ran for 1 minute 56 seconds and captured three MPDs.
  At 0.26 seconds, the long-duration video element first reported 4,574.014
  seconds. The trace also captured an interstitial MPD declaring 14.037
  seconds and requests for its audio/video initialization and media segments.
  Compared with the 4,560-second content baseline from prior captures of this
  title, the first observed duration was 14.014 seconds longer, within about
  23 milliseconds of the interstitial duration. This strengthens the evidence
  that preroll time can already be included in the earliest duration observed
  by a trace armed before playback; it does not reveal a clean, pre-ad duration
  in this run.
- The fourth trace also recorded a separate 37.120-second video duration and
  a non-interstitial MPD with the same duration. Along with the two video
  elements seen in earlier traces, this is consistent with the user's
  backdrop/preview-video hypothesis, but the trace does not associate each
  MPD with a specific element or establish what the page does with it.
- At 43.5 seconds into the fourth trace, a trusted click on an `input` target
  was followed by a pause/seek to media time 1,180.424 seconds (19:40.424),
  then playback resumed about 0.8 seconds later. Amazon issued a
  `getVideoAds` request at the seek, but the trace recorded no subsequent
  interstitial MPD or ad-media requests, no duration increase, and no
  playback-time discontinuity after resuming. This matches the user's
  observation that the marked break passed without ads playing. The request
  shows the player evaluated an ad opportunity; by itself it does not prove
  an ad was available or served. The trace supports distinguishing a timeline
  marker/ad decision from an actually delivered ad break.
- The third trace exposed a sanitizer gap: retained DASH text still included
  DRM `ContentProtection`/PSSH initialization metadata. It is not a
  decryption key, but can contain key identifiers and license configuration
  and should be treated as sensitive. Future captures now strip DRM/license
  elements. The already-exported trace predates that fix and should not be
  shared; delete the downloaded artifact when no longer needed.
- The user reports that the first Playback Trace start after opening Chrome
  or updating the extension causes a tab reload, after which the popup shows
  no trace and requires a second start. This is not explained by the current
  source path: `startPlaybackTrace` persists trace state before CDP attachment
  and does not call `chrome.tabs.reload`. The separate caption CDP retrieval
  path intentionally reloads after attaching so it can observe playback
  requests from the beginning. Treat the reported first-start reload and lost
  state as an unresolved live discrepancy until the installed build and
  browser/service-worker lifecycle are checked.

### Unknown

- The exact semantics of Pluto's repeated `InbandEventStream` descriptor on
  short periods. Its `schemeIdUri` is redacted in the retained MPD; determine
  whether this is an ad marker and whether any event payload adds details.
- Whether the Pluto caption fragments requested around the seek/ad sequence
  contain cues for ads, program content, or both, and how their source
  timestamps map to the player timeline.
- Whether Tubi's out-of-band ad decision/metadata can be identified from
  network metadata alone, and whether Tubi captions are active or available
  during a separately played ad sequence.
- Whether the Tubi behavior observed here—movie time pausing while a separate
  ad video element plays—is consistent across other titles and breaks.
- Whether ad boundaries are explicitly signaled, represented as separate
  periods/playlists, inferred by the player, or absent from the observable
  manifest.
- Whether ad playback reuses or replaces the content timeline, and how
  captions are timestamped across transitions.
- Whether the observed Pluto subtitle fragments can be assembled into a
  complete, correctly timed caption track, and how to avoid gaps or duplicate
  cues.
- Which findings generalize across services versus requiring provider-specific
  adapters. Amazon and Pluto both use DASH in the observed sessions, but
  Amazon's separately requested interstitial MPDs and Pluto's stitched
  `main.mpd` endpoint differ from Tubi's captured full-duration HLS playlists
  and separately played ad video element.
- What the Amazon ad MPDs say about period boundaries, media timestamps, and
  the relationship between the seven observed manifest URLs and the
  user-visible ad sequence.
- Whether Amazon's content and ad timelines share one presentation-time
  coordinate system, or how to map ad time back to program-relative time.
- Whether the early extensionless Amazon XML response is an MPD or another
  player document, and which MPD fields/markers correspond to the visible ad
  break.
- Whether a pre-roll-free duration is observable before the first
  advertisement. The fourth trace shows the earliest duration observation
  already closely matching content plus the captured preroll, rather than
  exposing a clean baseline.
- Whether Amazon's changing video duration alone remains a reliable
  cumulative-ad-duration measure across repeated breaks, seeking, title
  variants, and ad-first playback.
- Why the first trace start after browser startup or extension update is
  reported to reload the tab and lose the trace, despite the current source
  persisting the recording state before debugger attachment.

The existing Pluto evidence is recorded in
[caption-capture-project-state.md](caption-capture-project-state.md). The
manifest and segment bodies were not inspected in those observations.

## Working model to investigate

Treat playback as a graph and timeline rather than as one media URL:

1. **Discovery:** Arm observation from the service tab, independently of
   whether a video element has been found. Capture playback-related requests
   early enough to see player startup, initial configuration, manifests, and
   subsequent updates. Record request initiator/context and response
   status/MIME when available; a URL or MIME hint alone is not proof of a
   manifest. If observation starts after playback requests have completed,
   report that coverage limit rather than implying the trace is complete.
2. **Manifest identification:** Validate the body and structure before
   classifying it. Determine whether it is a master/index document, a media
   playlist, a DASH MPD, a player-specific document, or something else.
   Record parent/child relationships when one document references another.
3. **Timeline extraction:** Preserve the source's native timing and structure:
   periods, segment sequence, presentation timestamps, durations, start
   offsets, discontinuities, and updates. Do not flatten timestamps to a
   single clock until the mapping is understood.
4. **Ad/content classification:** Capture explicit boundary and ad-related
   signals when present, with their origin and exact scope. Keep
   `content`, `ad`, and `unknown` distinct; retain evidence and confidence
   rather than silently forcing a binary answer. A boundary or marker should
   not be treated as definitive without validating its semantics in context.
5. **Caption mapping:** Associate caption tracks/fragments with the relevant
   timeline and period. Preserve source timestamps and map them to playback
   time only when the offset/continuity rules are known. Track missing,
   repeated, or overlapping intervals.
6. **Cross-checking:** Compare the parsed structure with observed segment
   requests and playback progress. Where safe and available, compare with
   player state or native cues, noting that a rolling cue window is not a
   transcript archive. Align network, player, and intervention events on a
   monotonic capture clock as well as media time; media time can jump, reset,
   or be discontinuous.

This model is a starting hypothesis for investigation, not an implementation
specification. Use format-specific parsers only after observations establish
the formats that need support.

## Investigation strategy

1. **Arm the trace before playback is ready.** A single start action should
   work when no video has been discovered yet. Ideally start it on the service
   tab before navigating to or starting the title; at minimum, arm it before
   the player/video becomes available. This is especially important on
   services whose first playback is an ad. Record the arm time and whether
   capture began before navigation, player startup, or only after the page was
   already playing.
2. **Let the bounded trace run unattended.** Capture a compact local event
   timeline, not a live stream that needs a person or chat to keep up. Include
   playback lifecycle/time changes and relevant request metadata so later
   analysis can find startup, ad-like transitions, and manifest changes.
   Store only validated DASH/HLS text after removing resource URLs and
   DRM/license initialization data; never collect media segment bodies or
   arbitrary response bodies. The duration
   limit is 150
   minutes. At that limit, invoke the same stop/finalization path as a manual
   Stop action so the trace is closed cleanly and its artifact is available
   for later inspection. Initial pilot storage limits are 8 MiB of serialized
   trace records, 50,000 events, and a 2 MiB sub-budget for retained text
   bodies. Measure the logical UTF-8 JSON size of records before persistence;
   count retained bodies within the overall budget as well as against their
   sub-budget. These are starting safeguards to validate with a real trace,
   not platform quota guarantees. At about 75% of a budget, flag the trace as
   nearing capacity. Under pressure, first coalesce repeated request records,
   thin routine playback-time samples, and stop retaining optional body
   excerpts while preserving start/stop, page-click interactions, seeks,
   player/source changes, and request/manifest metadata. If any hard event or
   size cap is reached, stop and finalize through the manual Stop path, record
   which cap ended capture, and mark the artifact truncated/limit-ended rather
   than silently dropping arbitrary events. Keep traces out of sync settings;
   use a dedicated local persistence mechanism and enforce these limits in the
   recorder.
3. **Record interventions as first-class events.** While tracing, capture
   clicks in the page itself with timestamp, trusted/untrusted status, target
   tag/role, viewport coordinates, and current video times. Also log
   `seeking`/`seeked`, time jumps, pause/play, source changes, and relevant
   control events with their timestamps and before/after media times when
   available. A page click near a seek is useful evidence, but does not prove
   it caused the seek; label seek origin `unknown` unless the platform
   explicitly exposes it. Correlate nearby network bursts and player changes
   without treating proximity as proof of causality. The current content
   script only observes the top-level document; clicks inside cross-origin
   player frames may not be visible and must be checked in live tests.
4. **Capture and inspect the early request sequence.** Identify likely
   configuration, manifest/playlist, media-segment, and timed-text requests.
   Redact query strings and tokens. Note whether each body was actually
   available; absence from one observation mechanism does not prove the
   player did not use it. CDP only observes requests after attachment, so
   report the arm/attach boundary and any startup events that may have been
   missed.
5. **Inspect candidate bodies structurally.** The trace retains only bodies
   whose text validates as a DASH MPD or HLS playlist, strips resource
   references and DRM/license elements, rejects DTD/entity declarations, and
   limits each manifest to 1 MiB and all retained manifest text to a 2 MiB
   sub-budget. Inspect the
   exported, sanitized structure for format, timing relationships, periods,
   and ad markers. Do not save full signed URLs, credentials, or media or
   caption payloads in this note.
6. **Compare program and ad transitions.** Gather evidence before, during,
   and after an observed ad. Check whether manifest identity, period/playlist,
   segment sequence, timestamps, caption source, or playback time changes.
   Use recorded page-click events and their trust status to distinguish
   observed input from an unexplained transition. Mark competing explanations
   as unknown until an observation distinguishes them.
7. **Trace captions against the timeline.** Determine whether subtitle
   segments or cues align with content, ads, both, or neither. Test continuity
   and cue identity across transitions; do not infer completeness from a
   single successful segment or a non-empty native cue list.
8. **Repeat on another service before generalizing.** Compare the same
   evidence categories across providers. Add a shared behavior only when
   supported by multiple observations; isolate provider-specific behavior.
9. **Update this note with evidence and decisions.** Include test conditions
   and confidence. Promote a hypothesis to confirmed only when direct
   evidence supports it.

## Evidence record template

For each observation, record:

- Date and service; title at a high level.
- Playback state and approximate position, including whether an ad was
  visibly playing.
- Trace arm time and discovery method; whether observation began before
  navigation, player/video availability, or playback/network activity of
  interest, and the known capture/attachment boundary.
- Page-click events (trust status, target tag/role, coordinates, and current
  media times) and playback actions such as seek, pause, and play. Record
  timestamps and before/after media times when available; distinguish the
  observed click from any inferred causal relationship.
- Redacted host/path, response status, MIME type, and candidate role.
- Body format and structural validation result (without storing full bodies).
- Timeline facts: period/segment identifiers, sequence, presentation time,
  duration, offsets, discontinuities, and update behavior as applicable.
- Ad/content signals, their source and scope, classification, confidence, and
  alternative explanations.
- Caption track/fragment relationship, cue timing, and continuity findings.
- Known collection limits and unanswered questions.

Never record full signed URLs, cookies, authorization headers, credentials,
account details, full media/caption bodies, or unnecessary personal data.
Prefer a bounded local trace artifact containing only sanitized metadata and
validated, minimal text excerpts needed for analysis; avoid retaining raw
network dumps by default.

## Current focus and parked research

Additional service experiments and broad manifest gathering are paused at the
user's request. The evidence record above is the current basis for design, not
a claim that every heuristic is already validated.

The logical next development work is to implement the shared observable-media
model and internal content clock before adding popup presentation. Use
offline fixtures from the existing Amazon, Pluto, Tubi, and YouTube traces,
plus synthetic transitions, to test video-element selection, pause/buffer
handling, seeks, resume offsets, duration changes, separate ad elements,
same-element timeline changes, uncertainty handling, and evidence-ledger
explanations. Then add the popup row, optional ad labels/countdowns, and
user-invoked analysis export in priority order, making sure the report can
explain a surprising or low-confidence result. Do not schedule new manifest
experiments unless implementation tests reveal a concrete unresolved behavior
that blocks a prioritized goal.

The following questions remain parked rather than active data-gathering tasks:

- Can the content clock be mapped reliably through a same-element stitched
  ad transition when no clean content-duration baseline was observed?
- Which accessible DOM/ARIA clues are common enough to identify an active ad
  or a pod-wide countdown, and how often are they absent or misleading?
- Can any page-exposed, non-CDP schedule or manifest boundary provide a safe,
  trustworthy next-ad countdown? Until demonstrated, omit that indicator.
- Which Pluto descriptor identifiers can be retained safely if future
  manifest interpretation becomes necessary?
- Does YouTube's safe response summary produce useful fields after correcting
  the unexplained size-guard skip? This is not required for the first
  behavior-driven implementation and should remain parked.

## Playback Trace implementation status

**Implemented as a bounded metadata plus sanitized-manifest trace; live
validated on Amazon and Tubi and exercised on Pluto. Pluto's stitched MPD was
captured after increasing the per-document body-retention limit. Other
platforms remain unverified in Chrome.**

- The popup offers **Start Playback Trace** even when it has found no video.
  The background attaches CDP Network monitoring without reloading the tab;
  it records request/response metadata for document, media, XHR, and Fetch
  traffic. It reads response bodies only for successful candidate DASH/HLS
  requests and retains them only after format validation and URL redaction;
  arbitrary responses, media segments, DRM/license URLs, and HLS key IDs are not
  retained. It also reads successful JSON responses only from YouTube's
  `/youtubei/v1/get_watch` and `/youtubei/v1/player/ad_break` endpoints, when
  the reported response size is within 512 KiB. It retains a bounded summary
  (up to 100 fields) of ad-decision booleans, safe categorical values, and
  ad-context timing numbers—not the response body, free-form strings, URLs,
  IDs, or tokens. These YouTube summaries are implemented, but the latest
  ad-bearing trace's `get_watch` response was skipped by the size guard and no
  `ad_break` response occurred, so their live usefulness remains unvalidated.
- When a video is discovered, the content script records initial state,
  play/pause, seek, source/lifecycle events, and a media-time sample at most
  every 15 seconds. While active, it also records page clicks with
  `isTrusted`, target tag/role, viewport coordinates, and current video times.
  Seek origin remains unknown. The popup does not add a separate “mark”
  button.
- Network URLs omit query/fragment data and mask UUID/long opaque path
  segments. Captured manifest text also redacts resource URLs, BaseURL,
  query-bearing attribute values, DRM ContentProtection/PSSH and license
  elements, and HLS KEYID values while retaining timing and structural fields.
  Click text, form values, headers, cookies, and non-target response bodies are
  not captured. Top-level document clicks are observable; clicks inside
  cross-origin frames may not be.
- Events persist in bounded chunks in `chrome.storage.local`; the popup
  exports a sanitized JSON trace and requires the saved trace to be deleted
  before starting another. The 150-minute Chrome alarm ends through the same
  finalization path as manual Stop. A debugger detach is recorded as a failed
  trace rather than a successful completion.
- Pilot caps are 8 MiB of serialized event records, 50,000 stored event
  records, a 2 MiB retained-manifest-text sub-budget, and a 1 MiB per
  manifest limit. At 75%, the trace warns; duplicate
  network request/response records can be coalesced within a 30-second window
  while retaining repeat count. Routine time samples are already thinned.
  Reaching a hard cap finalizes and marks the trace limit-ended.

Focused automated coverage verifies URL redaction, YouTube response-summary
allowlisting and bounds, cap calculations,
pre-video popup availability, network metadata recording, event export,
150-minute alarm finalization, manifest validation/sanitization, body capture,
and video/seek/page-click event collection. The third and fourth Amazon traces
confirm manifest body retrieval and local export work in Chrome for Amazon;
the earlier Pluto trace confirmed startup-manifest metadata capture but
exceeded the former 256 KiB per-document limit. The second Pluto trace confirms
the new 1 MiB ceiling retains the sanitized 270,781-byte MPD. Other platforms
and a full unattended movie run remain untested.
A first Amazon trace did complete and export after a manually stopped
4-minute-26-second run; it contained 1,161 events and about 311 KB of
serialized event data, with no response bodies. It captured the ad-decision
call and ad-delivery requests but not manifest contents. A second
pre-playback Amazon trace found early DASH-host XML and a later ad MPD
request. A third trace captured ten MPDs and showed their declared ad
durations closely matching the video-duration increase. That third artifact
was exported before the DRM sanitizer fix and contains ContentProtection/PSSH
metadata; treat it as sensitive and do not share it. Delete the downloaded
file when no longer needed. The updated sanitizer now removes DRM/license
elements, with regression coverage.

The current hypothesis is that, for this Amazon title/session, the player
duration minus the 76-minute content baseline approximates ad time included
in the player timeline. The baseline is supported by two corrected content
MPD durations (20:14.922 + 55:45.078); in one trace, the 161.161-second
duration increase nearly matches the 161.355 seconds declared across eight
interstitial MPDs. The fourth trace adds evidence for preroll: its earliest
long-video duration was 14.014 seconds above the baseline, nearly matching
the 14.037-second preroll MPD. Thus, duration arithmetic may help estimate
total ad time included in the player duration when a separate content baseline
is known, but it cannot be assumed that the first observed duration is
content-only. Nor does total duration reveal where ad time falls relative to
the current playhead. The user-seeked break in the fourth trace generated an
ad-decision request but no captured ad media or duration change, showing that
a visible marker/request is not proof that an ad was delivered. This remains
strong evidence from one title, not a general cross-service normalization
rule.

The Pluto run broadened the evidence beyond Amazon. Its captured stitched MPD
supports a breakpoint-then-resume hypothesis: a timeline seek landed within a
fraction of a second of a descriptor-bearing period boundary, the marked
periods there total about 150 seconds, and playback automatically jumped
forward from just beyond the following program-period boundary about as that
pod ended. The exact requested destination remains unknown.

Across services, observed ad behavior differs: Tubi played ads in another
video element while content time held; Amazon's main duration grew alongside
interstitial delivery; Pluto represented candidate pods as periods on a
stitched timeline; and YouTube exposed short ad playback timelines before
loading a saved movie position. These observations motivate a generic
state-based design, but they do not prove one universal ad detector or
normalization formula. In particular, total-duration arithmetic alone cannot
locate ad intervals or reconstruct content-relative time.

Manifest parsing, provider-specific response interpretation, and further
network experiments are not prerequisites for the initial non-CDP
implementation. Keep the current trace and sanitizer as research tools; do
not make the popup timer depend on CDP attachment or on the unresolved
YouTube response summaries.
