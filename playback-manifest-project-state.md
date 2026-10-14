# Playback manifest discovery and processing: project state

Last updated: 2026-10-13

## Purpose

Develop an evidence-driven, cross-service strategy for discovering and
interpreting playback manifests and the media timeline they describe. The
strategy should help distinguish program content from inserted advertisements
and ultimately explain how timed captions align with each part of playback.

The intended experiment workflow is a one-click **Playback Trace** that can be
started on a service tab before the extension has discovered a video element.
Some services may begin with an ad as soon as the player/video becomes
available, so video discovery must not be a prerequisite for arming capture.
The trace should then run unattended for a full test movie and leave a
bounded, locally reviewable record for later analysis rather than requiring
someone to watch the browser or stream raw network events into a chat. For
these experiments, the expected maximum movie duration including ads is 150
minutes; reaching that limit should stop and finalize the trace exactly as if
the user had clicked Stop.

This is an exploration note, not a claim that the extension currently parses
manifest timing semantics or identifies ads automatically. It can retain
bounded, structurally validated, sanitized DASH/HLS manifest text for
inspection. Record observations as **confirmed**,
**disproven**, or **unknown**. Keep provider-specific details separate from
cross-service conclusions.

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

Manifest interpretation is therefore a prerequisite to designing a reliable
Pluto caption strategy, and a likely shared capability across services. It
must not assume that all providers expose ads in the same way, that a manifest
is always accessible to the page, or that every manifest marker unambiguously
identifies an ad.

Efficient experiments also need a causal timeline. A user may seek forward to
trigger an ad, while the seek itself or the resulting downloads and player
events can resemble an automatic ad transition. Trace records should make
user interventions visible and time-correlated with playback/network events,
without claiming causality from correlation alone.

## Current evidence

### Confirmed

- Caption discovery, retrieval, and normalization are user-confirmed for
  YouTube, Prime Video, and Tubi, as described in the related project note.
- Pluto playback has produced successful `200` responses for paths shaped
  like `/dash/.../text/en-cc/<segment>.m4s`, with MIME type
  `video/iso.segment`, alongside audio and video segment requests.
- Pluto exposes a Shaka `TextTrack` whose cue list changes during playback.
  Snapshots suggest a moving cue window; reading the track only once may miss
  earlier cues.
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

- Which manifest or playlist formats and variants are used by each service
  during target playback sessions. Candidate manifest body capture has been
  live-validated on Amazon; it remains unverified on other providers.
- Whether Pluto's startup manifest can be observed and how its subtitle
  fragments are described or timed.
- Whether ad boundaries are explicitly signaled, represented as separate
  periods/playlists, inferred by the player, or absent from the observable
  manifest.
- Whether ad playback reuses or replaces the content timeline, and how
  captions are timestamped across transitions.
- Whether the observed Pluto subtitle fragments can be assembled into a
  complete, correctly timed caption track, and how to avoid gaps or duplicate
  cues.
- Which findings generalize across services versus requiring provider-specific
  adapters.
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
   limits each manifest to 256 KiB and all retained manifest text to a 2 MiB
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

## Open questions and next steps

- Establish a repeatable way to identify and read candidate playback manifests
  without assuming access to a particular browser debugging mechanism, with
  an arming action that works before any video element is discovered.
- Live-validate the implemented one-click trace lifecycle, 150-minute stop,
  storage caps and overflow behavior, early attachment, local persistence,
  export, and click/seek correlation. In particular, verify whether clicks
  inside each platform's player frame are observable.
  - Reproduce the reported first-start reload immediately after browser startup
    and after an extension update. Confirm the installed extension directory and
    version, note whether the page or extension/service worker reloads, and
    inspect the popup state plus `playbackTraceMeta` in `chrome.storage.local`
    after the first click. Compare that with the explicit reload performed by
    caption CDP retrieval; do not add another-click or automatic-reload behavior
    until the path causing this discrepancy is identified.
- On Pluto, observe an early playback session and determine whether the
  startup manifest can be captured; inspect its structure and the relationship
  between its subtitle references and the observed `text/en-cc/*.m4s`
  responses.
- Observe a visible ad transition on Pluto and compare the timeline and
  caption requests before, during, and after it.
- Select one of the already-working caption services for comparison and
  collect the same manifest/timeline evidence categories.
- Based on these results, decide what a minimal shared representation must
  preserve and which semantics belong in provider-specific parsing.

## Playback Trace implementation status

**Implemented as a bounded metadata plus sanitized-manifest trace; initial
live validation on Amazon, with DRM sanitization tightened after inspecting
the first captured MPDs; other platforms remain unverified in Chrome.**

- The popup offers **Start Playback Trace** even when it has found no video.
  The background attaches CDP Network monitoring without reloading the tab;
  it records request/response metadata for document, media, XHR, and Fetch
  traffic. It reads response bodies only for successful candidate DASH/HLS
  requests and retains them only after format validation and URL redaction;
  arbitrary responses, media segments, and DRM/license metadata are not
  retained.
- When a video is discovered, the content script records initial state,
  play/pause, seek, source/lifecycle events, and a media-time sample at most
  every 15 seconds. While active, it also records page clicks with
  `isTrusted`, target tag/role, viewport coordinates, and current video times.
  Seek origin remains unknown. The popup does not add a separate “mark”
  button.
- Network URLs omit query/fragment data and mask UUID/long opaque path
  segments. Captured manifest text also redacts resource URLs, BaseURL,
  query-bearing attribute values, DRM ContentProtection/PSSH, and license
  elements while retaining timing and structural fields.
  Click text, form values, headers, cookies, and non-manifest body contents are
  not captured. Top-level document clicks are observable; clicks inside
  cross-origin frames may not be.
- Events persist in bounded chunks in `chrome.storage.local`; the popup
  exports a sanitized JSON trace and requires the saved trace to be deleted
  before starting another. The 150-minute Chrome alarm ends through the same
  finalization path as manual Stop. A debugger detach is recorded as a failed
  trace rather than a successful completion.
- Pilot caps are 8 MiB of serialized event records, 50,000 stored event
  records, a 2 MiB retained-manifest-text sub-budget, and a 256 KiB per
  manifest limit. At 75%, the trace warns; duplicate
  network request/response records can be coalesced within a 30-second window
  while retaining repeat count. Routine time samples are already thinned.
  Reaching a hard cap finalizes and marks the trace limit-ended.

Focused automated coverage verifies URL redaction, cap calculations,
pre-video popup availability, network metadata recording, event export,
150-minute alarm finalization, manifest validation/sanitization, body capture,
and video/seek/page-click event collection. The third and fourth Amazon traces
confirm manifest body retrieval and local export work in Chrome for this
provider; other platforms and a full unattended movie run remain untested.
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

The next experiment should be a before/during/after Playback Trace on Pluto,
preferably while also observing its known caption-segment requests or native
caption cues. Pluto is the highest-value next step because it can test whether
the trace captures a second provider's manifest format and ad-boundary
signals, while directly connecting the original caption-timing question to
ad transitions. Arm before playback; note whether the opening ad is visible,
and capture one later transition if practical. Compare manifest/playlist
structure, video duration and media time, ad-related requests, and subtitle
segment/cue activity; distinguish a marked or requested break from an ad
whose media is actually fetched or played. Avoid trying to force a complete
cross-platform model from a single run.

The Amazon evidence is already strong enough to justify broadening the sample:
the two content MPDs on either side of the visible break sum to the clean
76-minute program baseline, and captured interstitial durations closely
account for inserted time. Further Amazon work is still useful, but can be a
targeted follow-up if Pluto leaves a question that Amazon can answer—for
example, parsing sanitized MPD segment timestamps to map content positions
across the split, or determining what the `getVideoAds` response says when a
marked break is skipped. The current trace does not capture that JSON body.
This implementation captures and redacts manifest text; it does not yet
parse timeline semantics or classify ad/content periods. No further click
timing instrumentation is planned for this investigation.
