# Caption capture: project state and direction

Consolidated working note based on [caption-capture-notes.md](caption-capture-notes.md),
[caption-capture-chat-history.md](caption-capture-chat-history.md), and the
additional report that the popup can become stale while open and can repeat
already-completed work after reopening.

Last updated: 2026-10-13

## Purpose

Build a dependable caption-capture experience that can find and retrieve
complete, timed captions across streaming services, without assuming that
services expose captions in the same way. Make the extension explain what it
is doing, preserve progress and results across popup close/reopen, and avoid
repeating or conflicting work.

This note is the shared record for future investigation and implementation.
Update it with observed evidence as work proceeds. Keep secrets and user data
out: do not record signed URLs, tokens, cookies, authorization headers, account
details, or full caption payloads.

## Executive summary

There is no single universal way to read captions from streaming services.
Depending on the player, complete timed text may be available through native
text tracks, a directly fetchable caption file, page-visible data, or a
captured network response. A visible caption overlay alone is not a complete
transcript.

The project has confirmed useful complete-caption paths for Prime Video,
YouTube, and Tubi, but the evidence and access conditions differ. Most
recently, the user confirmed that YouTube, Amazon/Prime Video, and Tubi now
surface timed-caption URL candidates automatically through passive discovery:
no `Find captions` click or CDP session was needed, and further candidates
arrived over time while the popup remained open. This is a major improvement
to discovery and live popup synchronization, but it does not establish that
every candidate can be fetched or that its body contains usable timed cues.
Pluto's visible captions have not yielded native cues or a confirmed complete
body. These results argue for a layered, evidence-driven discovery pipeline
rather than service-specific assumptions or a single URL heuristic.

Some prior browser findings were collected after rebuilding and explicitly
reloading the extension from Chrome's Manage Extensions page. Other early
observations were made after a rebuild but before that extension reload, so
they may describe stale loaded code and should not be treated as reliable
evidence of current behavior. The latest report was collected after the
rebuilt extension was reloaded through Chrome's Manage Extensions page. Its
passive discovery and retrieval findings therefore describe the reloaded
build, although they do not by themselves verify CDP behavior because those
tests did not rely on CDP.

The current evidence separates a now-confirmed improvement in passive
discovery from unresolved retrieval failures. YouTube, Amazon/Prime Video, and
Tubi all exposed caption URL candidates automatically, without manual
discovery or CDP, and additional candidates appeared incrementally in the
open popup. Earlier tests found that YouTube's timed text downloaded
successfully while Amazon and Tubi fetches failed with network errors; the
latest confirmation concerns discovery and popup updates, not a re-test of
retrieval. A discovered URL is not proof that its body can be fetched,
validated, normalized, or downloaded. The next evidence-based increment
should target that separate retrieval boundary, while preserving and
regression-testing the newly working passive discovery behavior.

The CDP response-validation increment has focused automated coverage, but
its live Chrome behavior has not yet been retested. Earlier observations of
CDP-only delayed candidate updates and false-positive metadata/font
candidates remain useful motivating evidence, not confirmation of current
behavior after the latest implementation changes.

**Content-script loading investigation:** The reported YouTube errors are
consistent with a possible content-script loading or lifecycle problem, but
the exact relationship to missed caption discovery is not established.
Inspection found that the local `node_modules` had
`@crxjs/vite-plugin@2.7.1`, while both `package.json` and `package-lock.json`
specify version 3.0.0. Restoring dependencies with `npm ci` brought the
installed plugin back to 3.0.0. A clean production build and all three
production browser tests then passed, including content-script messaging on
initial load, after delayed video insertion, and with accessible iframe
content. The user subsequently rebuilt and reloaded the extension, closed the
entire browser, and ran the `chrome:debug` task multiple times. Chrome still
reported an unsafe attempt to load the generated content-script module URL
from YouTube's page URL. Despite that error, timed-text discovery eventually
worked in at least one run. Thus the error persists in the user's environment,
but the extension can also function despite it; whether the warning reflects
a blocked essential module, a non-fatal browser warning, or a contributing
intermittent fault remains unknown. The test-browser result does not
reproduce or dismiss the user's Chrome warning.

The user initially observed the same open YouTube tab and paused video show
the video and timed-text candidate in one popup opening, then no videos in a
later opening. The user could not test `Find captions` in the empty state
because that control is hidden when no videos are detected. A code inspection
found competing video-state sources (a direct active-tab query and global
background snapshots), so video broadcasts were made tab-scoped and the
popup now ignores unscoped or other-tab updates; focused tests cover this
guard. Subsequent controlled-by-user repetition clarified the observed
boundary: popup close/reopen by itself did not lose the video, while clicking
`Reload` in Chrome's extension manager with the YouTube tab still open
reproducibly caused the popup to show no videos. The same sequence worked
again after closing the browser, launching `chrome:debug`, and confirming the
video before reloading the extension. This points to extension reload
invalidating the already-injected content script rather than ordinary popup
reopening. Since extension reload with a page left open is not a normal user
workflow, do not prioritize preserving that page's content script across the
reload; refresh the page after extension reload when validating. The
tab-scoping safeguard is still valid, but the observations do not establish
that its race caused the earlier symptom or that it addresses the reload case.

**Current investigation priority: improve the non-CDP workflow.** CDP is
disruptive to the user, so do not spend the next increment polishing CDP
unless a specific non-CDP question cannot otherwise be answered. First make
passive discovery reliably find and refresh real caption candidates, then
diagnose why known Amazon and Tubi URLs fail to retrieve while YouTube works.
The longer-term goal is to make CDP unnecessary across the extension; for
now, keep it as a deliberate fallback and a possible comparison tool, not the
default next step.

## Evidence by service

### Prime Video / Amazon

- A Prime Video playback requested a `.ttml2` resource from
  `cf-timedtext.aux.pv-cdn.net`. The response was successful (`200`) and its
  `application/octet-stream` body was TTML XML with timed cues, line breaks,
  and styling spans.
- For the observed resource, the page could fetch the complete body with
  `credentials: 'omit'`; the response allowed `Access-Control-Allow-Origin: *`
  and did not allow credentialed CORS. This is evidence about that resource,
  not a general rule for all Amazon URLs or other services.
- The CDP watcher also captured and recognized a usable TTML body. The video
  elements inspected did not expose usable native text-track cues.
- Passive discovery can show generic player-resource JSON or a caption-like
  DOM surface without showing the actual TTML. The TTML request may appear
  later, and a post-hoc resource-timing snapshot can miss it. Do not stop
  observation at the first JSON-like response.
- In an earlier browser report, the real timed-caption URL was eventually
  found without CDP, but required repeated `Find captions` clicks. In the
  latest browser validation, Amazon/Prime Video caption URLs appeared
  automatically without clicking `Find captions` or starting CDP, and
  additional candidates arrived over time in the open popup. This confirms
  the passive discovery/update behavior for the tested session, not
  end-to-end retrieval.
- Fetching a previously discovered Amazon URL failed with a network error.
  This does not establish the cause, and retrieval has not yet been reported
  as re-tested alongside the latest discovery success.
- A prior browser run found a `.ttml2` candidate only after CDP monitoring
  was paused and successfully downloaded it. That confirms a usable CDP path
  for that run, distinct from the latest passive-discovery URL whose fetch
  failed. The difference between these retrieval outcomes is unexplained.

### YouTube

- A timed-text request was observed at `/api/timedtext`.
- Its response used YouTube's `pb3`-style JSON shape: `wireMagic`, timed
  `events`, `tStartMs`, `dDurationMs`, and text in `segs[].utf8`.
- This contains enough timing and text for bulk normalization. It is a
  provider-specific JSON format, not generic JSON; accept it only when the
  body contains actual timed events and text.
- Initial passive classification called the request `player-control`. The
  useful body was identified by inspecting the actual downloaded response,
  not by trusting that classification.
- In an earlier browser report, passive discovery eventually found the real
  timed-caption URL without CDP, after the user clicked `Find captions`
  multiple times, and the user successfully downloaded the timed text.
- In the latest browser validation, YouTube caption URLs appeared
  automatically without clicking `Find captions` or starting CDP, and
  additional candidates arrived over time in the open popup. This supersedes
  the earlier repeated-click behavior as the latest discovery result; it does
  not by itself establish that every candidate is a valid timed-text body or
  that retrieval remains reliable across sessions.
- Earlier CDP testing reported a base64 JSON metadata data URL mislabeled as
  SRT alongside a separate JSON timed-text response, and candidates appeared
  only after pausing CDP. These were observed before the current CDP
  body-validation increment; verify that metadata is now rejected and valid
  candidates arrive live rather than assuming either behavior is fixed.

### Tubi

- A complete `.srt` file was downloaded during manual inspection. Its
  GUID-like filename concealed ordinary SRT with absolute cue times and text.
- Tubi's visible captions did not correspond to a usable native cue list in
  the initial probe; the probe classified the evidence as `unknown`.
- Extension-origin and page-world fetches of a candidate URL have failed
  with `Failed to fetch`. DevTools attributed a prior failing initiator to
  the extension, so this establishes a failure for that extension attempt,
  not that Tubi's player request failed.
- A later CDP experiment captured and normalized a Tubi caption payload.
  Passive discovery and CDP may report the same URL. Deduplication must keep
  the captured body reachable from the candidate shown to the user.
- Thus a complete Tubi SRT and a CDP capture path are confirmed; reliable
  discovery and behavior should still be checked against current diagnostics.
  This supersedes the earlier open-question wording in
  `caption-capture-notes.md` that said no Tubi path had been verified.
- The latest browser validation confirms that Tubi caption URLs appeared
  automatically without clicking `Find captions` or starting CDP, with
  additional candidates arriving over time in the open popup. Earlier
  attempts to fetch the discovered URL failed with a network error; the
  explicit error was `network: Failed to fetch`. The latest report confirms
  discovery, not a new retrieval attempt. Whether the browser request is
  rejected by CORS, credentials, service policy, or another fetch condition
  is unverified.
- Because YouTube's discovered timed text downloaded successfully while
  Amazon and Tubi fetches failed, success at URL discovery cannot be used as
  a proxy for retrieval capability; treat each stage and result separately.

### Pluto

- The initial probe found a `native-track` with track metadata and
  subtitle-related evidence. Captions were visible in the player, but the
  exposed `TextTrack` had no usable cues.
- Native extraction once generated header-only WebVTT. This was a false
  success; empty cue lists must be rejected and reported with diagnostics.
- Probe diagnostics were expanded to include track mode, `<track>` ready
  state, cue and active-cue counts, source presence, and limitations.
- In current browser use after explicitly reloading the rebuilt extension,
  CDP finds two `data:` responses with MIME type `application/font-woff2` and
  labels both high-confidence `srt` candidates. A downloaded file is treated
  by VS Code as binary or unsupported text. The MIME type and behavior
  strongly suggest these are fonts, not subtitles; actual response bytes were
  not inspected here, so record them as likely false positives rather than
  conclusively identifying the body.
- Whether complete Pluto caption text is present in a readable response body
  or uses a different player-specific pipeline remains unresolved.

## What "available" means

Keep these facts separate in implementation, logs, and UI:

1. A caption control/menu exists.
2. A native track exists.
3. A candidate response URL was observed.
4. A response body was successfully read.
5. The body was recognized as timed text with usable cues.
6. The cues were normalized and can be downloaded.

Evidence for an earlier stage is not proof of a later one. In particular, a
caption menu, visible overlay, generic player JSON, URL match, or empty WebVTT
header is not evidence of a complete downloadable caption source.

## Current implementation shape

- Passive discovery now starts when the content script initializes, observes
  resource timing entries with a buffered `PerformanceObserver`, and debounces
  rescans after relevant DOM changes. Likely caption URLs observed by the
  observer are sent incrementally to the background, including the observed
  URL itself so a timing-buffer rollover cannot silently discard the trigger.
  The background deduplicates candidates per tab, persists the merged state,
  and broadcasts it to an open popup. A popup opened later receives the same
  stored candidates. Resource-URL candidates remain low-confidence and their
  format is not inferred beyond existing URL evidence.
- Focused automated tests cover a late resource becoming a content-script
  candidate and the background persisting/broadcasting its incremental update.
  The user has now confirmed live automatic discovery of caption URL
  candidates on YouTube, Amazon, and Tubi without a manual `Find captions`
  action or CDP, with further candidates appearing over time while the popup
  stays open. This validates the central incremental-discovery milestone.
  Whether the same candidates persist after popup close/reopen has not yet
  been reported for this test. If `PerformanceObserver` is unavailable or
  cannot observe resource entries, the content script reports that limitation
  in its console rather than silently claiming continuous observation.
- `src/shared/utils/caption-discovery.ts` finds native tracks, resource-timing
  URLs, caption-like URLs in selected page JSON scripts, and caption-shaped
  DOM surfaces. It does not read network response bodies.
- `src/shared/utils/caption-fetch.ts` recognizes WebVTT, TTML, SRT, and JSON
  and fetches a known URL. Current shared fetching omits credentials. Other
  credential policies remain unverified and should be handled explicitly
  rather than generalized from the Prime Video observation.
- `src/entries/background/service-worker.ts` first performs passive page
  discovery and direct page-context retrieval. CDP monitoring is a separate,
  explicit action that reloads the tab. The current CDP run is bounded by a
  90-second timeout; pausing ends that run, and resuming starts another run
  that reloads the tab rather than resuming the same debugger session. The
  worker broadcasts per-tab capture state and persists candidates, retrieval
  results, and captured bodies in `chrome.storage.session`, restoring them
  after worker startup.
- `src/entries/popup/App.tsx` subscribes to those per-tab updates and requests
  the current snapshot when it opens. The development UI shows likely
  candidates and their retrieval outcomes, plus the transition to active or
  paused CDP monitoring. While CDP traffic is being triaged, it also shows a
  compact summary of responses inspected, bodies checked, validated candidates,
  grouped rejection reasons, and body-read failures; it does not list every
  inspected request or expose response payloads.
- The CDP path now filters known non-text MIME types and requires a supported
  body signature plus successful normalization to one or more timed cues
  before accepting a captured response. JSON must contain actual timed events
  and text; metadata-only JSON, fonts, and empty/invalid caption documents are
  rejected. Accepted candidates are broadcast immediately, merged with
  duplicate passive candidates, and retain the captured body under the
  candidate identity shown in the popup. For accepted `data:` responses, the
  persisted candidate URL is redacted so the inline payload is not duplicated
  in popup state or session storage metadata; retrieval uses the cached body.
- Focused tests cover SRT, WebVTT, TTML, timed-event JSON, metadata JSON,
  binary MIME rejection, popup traffic summaries, and a validated CDP
  candidate appearing while monitoring remains active. Type-check, lint,
  tests, and build passed for this increment. This automated evidence does not
  establish live Chrome behavior: confirm incremental candidate updates,
  rejection of YouTube metadata and Pluto fonts, and summary counts after
  explicitly reloading the rebuilt extension.
- The new validation applies to bodies read through CDP. Passive discovery
  still uses URL, DOM, and page-resource evidence, so its candidates may be
  less certain until retrieval validates their contents. Do not interpret
  every passive candidate as a confirmed caption file.
- The popup's `Failed to fetch videos: ... Receiving end does not exist`
  means its `GET_VIDEO_ELEMENTS` message had no listening content script in
  that tab; it is not evidence that the page contains no video. The reported
  `Extension context invalidated` and a missing receiver are expected if a
  tab remains open across an extension reload and its existing content script
  belongs to the invalidated extension context. The user reproduced this:
  the popup detected YouTube's video before extension-manager `Reload`, then
  showed no videos after reload with that tab still open. Closing the browser
  and starting a fresh `chrome:debug` session restored detection until the
  extension was reloaded again. Treat this as a development/reload lifecycle
  boundary; refresh the tab after reloading the extension rather than trying
  to keep old content scripts alive.
- The unsafe attempt to load the generated extension bundle from YouTube
  still appears after restoring the locked CRXJS 3.0.0 dependency, a full
  browser close, and repeated `chrome:debug` runs. In at least one such fresh
  session, timed-text discovery eventually succeeded. Its relationship to
  candidate discovery remains unknown; do not assume it explains the
  intermittent caption candidate or video state.
- Popup video rendering previously accepted unscoped background state for any
  tab alongside the direct active-tab query. This allowed stale or
  other-tab `videos: []` state to clear a valid active-tab result. Video
  broadcasts now carry their sender tab ID, and the popup ignores unscoped or
  non-active-tab video updates. Focused tests pass for this behavior, but
  browser observations have not shown that this was the cause of the reported
  disappearance: repeated popup openings preserved videos until Chrome's
  extension-manager `Reload` was clicked while the tab stayed open. After
  reloading the extension, refresh the page so Chrome injects a fresh content
  script. If the popup still has no video after that refresh, then diagnose a
  current content-script connection failure.
- Popup state remains ephemeral by design, but the background state is
  mirrored to session storage so worker termination does not by itself erase
  progress or retrieved artifacts. Session storage is scoped to the browser
  session and has a quota; persistence across browser restarts or unusually
  large caption sets is not established.
- Earlier browser tests found YouTube and Amazon timed-caption URLs only after
  multiple manual `Find captions` actions; that discovery symptom is
  superseded by the latest user-confirmed automatic discovery on YouTube,
  Amazon, and Tubi. Earlier retrieval tests still matter: YouTube's candidate
  downloaded successfully, while Amazon and Tubi candidates failed with
  network errors. The current non-CDP priority is therefore retrieval and
  payload validation, not adding more discovery polling or retries without
  evidence. Avoid making CDP changes the next step absent a concrete need.
- In the latest run after a clean `chrome:debug` launch, the popup initially
  continued to find the video across repeated close/reopen cycles, but did
  not find the timed-text resource. Only after clicking Chrome's extension
  manager `Reload` with the tab still open did the popup report no videos;
  the user reproduced this behavior. This reload case should not be confused
  with normal popup reopening and need not be fixed unless a real user
  workflow exhibits it.
- Earlier YouTube observations were inconsistent: waiting for visible
  captions before opening the popup did not always make the timed-text
  resource appear. The latest browser test supersedes that uncertainty for
  the tested session: timed-caption candidates appeared automatically and
  incrementally without CDP or a manual discovery action. Whether that result
  is repeatable across sessions and whether candidates survive popup
  close/reopen remain to be checked. The unsafe-load warning's relationship
  to discovery remains unknown.
- When one tab enters CDP mode, the user reports seeing Chrome's
  `"Family Watch Night - Virtual Remote Control" started debugging this browser`
  banner across the top of newly opened tabs. This indicates Chrome is
  presenting a debugger warning, but does not establish that each new tab is
  attached to CDP, monitored by the extension, or sharing the original tab's
  capture state. The debugger attachment scope and lifecycle are unverified.
- Earlier reports of the debugger banner and Tubi's immediate timeout/
  "already running" message may have come from stale loaded code: the
  extension had been rebuilt but not reloaded through Chrome's Manage
  Extensions page. Those reports are not reliable evidence about the current
  build. The latest passive-discovery and network-error report was made after
  reloading the rebuilt extension, and is current evidence for those
  non-CDP behaviors. It does not verify the CDP triage changes; live
  verification of that increment is still pending.
- The implementation has focused unit-test, type-check, lint, and build
  coverage for the CDP triage increment. Current browser validation is still
  required for CDP body filtering and incremental UI updates; Tubi
  direct-fetch behavior remains unresolved.
  Popup reopen and MV3 worker-suspension behavior also need confirmation in a
  live extension.
- Related implementation files are being actively changed; inspect the
  current working tree before assuming these details have not changed.

## User experience and state problem

The intended architecture puts state in the background, persists it for the
browser session, and sends popup updates. The latest browser result confirms
that passive candidates are now discovered and streamed into an open popup
automatically on three services. Remaining gaps are end-to-end retrieval,
candidate/body validation, and lifecycle verification:

- Earlier repeated-click discovery on Amazon and YouTube is historical and is
  superseded by the latest confirmation: YouTube, Amazon, and Tubi now surfaced
  candidates with no `Find captions` click and no CDP, with more candidates
  appearing over time in the open popup. The mechanism's reliability across
  sessions and persistence after popup close/reopen remain unverified.
- YouTube's timed text downloaded successfully. Fetching the discovered
  Amazon and Tubi URLs failed with network errors. For Tubi, the explicit
  failure previously shown was `network: Failed to fetch`; for the latest
  Amazon report, no lower-level error was provided. The origin of these
  failures (including request context, CORS, credentials, response status, or
  service policy) has not been established.
- Earlier browser tests showed Amazon/YouTube CDP candidates appearing only
  after `Pause CDP`. The implementation now intends to publish validated
  candidates live, but this remains unverified in Chrome after the CDP
  triage change. This is not the immediate focus: CDP entails a disruptive
  debugger attachment/reload, while the latest run found usable URLs through
  passive discovery.
- The user confirmed that repeated popup openings preserved video detection
  in a paused YouTube tab until the extension itself was reloaded from
  `chrome://extensions` while the tab remained open. After that reload, video
  detection failed until a fresh browser/debug session; this is consistent
  with an invalidated content-script context in an already-open page and is
  not the normal user flow. Refresh the page after extension reload for
  subsequent checks. A separate tab-scoping safeguard was implemented because
  global background video snapshots were ambiguous, but it has not been
  shown to cause or fix this reload-specific behavior.
- The unsafe-load message persisted after the full browser close and repeated
  `chrome:debug` runs, while timed-text discovery eventually worked in at
  least one earlier run and has now succeeded automatically across three
  services. Whether that error contributes to discovery or has any relation
  to retrieval remains unknown; do not treat it as the cause without new
  evidence.
- Earlier CDP parsing labeled JSON metadata and WOFF2 font responses as SRT.
  The current CDP body-validation path is designed to reject these cases;
  verify that in the browser. Passive candidates remain a separate,
  hint-driven discovery surface and are not all body-validated up front.
- The prior Tubi timeout/active-CDP collision and debugger-banner reports
  were made before explicitly reloading the rebuilt extension, so they may
  have reflected stale code. The latest passive-discovery and retrieval
  observations were made after reloading the rebuilt extension, but do not
  verify the CDP triage increment. CDP remains a high-disruption fallback and
  should not be the focus of the next increment; the longer-term goal is to
  remove any need for it. The debugger banner's actual attachment scope
  remains unverified.
- These observations establish outcomes, not the cause of Amazon/Tubi fetch
  failures. Capture the request context and the exact failing retrieval stage
  before changing fetch behavior.
- Earlier reports of popup reopen losing state and repeated actions colliding
  remain lifecycle cases to validate. Session-backed persistence is intended
  to address worker termination, but the latest automatic-discovery test did
  not report whether candidates survived popup close/reopen.

Treat this as a state-ownership and lifecycle design problem, not merely a
popup refresh bug. There should be one authoritative capture state per tab
(and, where necessary, per operation/candidate), with popup views that
reconcile from it. The user should see progress and results without needing
to guess which action to repeat.

## Target behavior

The eventual UX should:

- Keep detailed operation state authoritative in the background, but do not
  turn that internal model into a user-facing list of every possible source
  candidate with its own status. In ordinary use, show the useful outcome:
  whether usable captions were found and are ready, or what the user can do
  next. Update an open popup as that outcome changes and reconstruct the same
  current view when the popup is reopened.
- During the current development/debugging stage, expose a compact
  `finding captions` state and show only likely candidates the discovery
  process actually found, with a clear success or failure for each. Do not
  flood this view with every inspected URL or speculative possibility.
  Candidate-level diagnostics are for understanding which plausible path
  worked or failed; they need not become the permanent end-user presentation.
  When background CDP work discovers a candidate after the initial probe,
  merge it into the open popup automatically; do not require another
  `Find Captions` click to reveal results.
- Distinguish the overall discovery phase from individual likely-candidate
  results. Initially, communicate that the extension is trying the available
  non-CDP approaches (for example native cues and direct/page-visible
  resources). If those approaches find no usable captions, report what was
  attempted and what remains unknown. CDP may be offered as an explicit,
  clearly described, disruptive fallback, but should not be treated as the
  automatic next step. The long-term direction is to make the extension work
  without requiring CDP.
- If the user deliberately proceeds to CDP mode and the page is reloaded as
  required, make it clear that CDP is now actively monitoring for caption responses.
  Provide an explicit way to pause and resume that monitoring, and show
  whether it is active or paused. Preserve this phase and its results when the
  popup closes or reopens; do not make users infer monitoring from a stale
  button state or repeat a completed step. Keep the debugger attached only to
  the intended tab/session, and make its lifetime clear; unrelated tabs
  should not appear to have entered caption monitoring as a side effect.
- Keep status language concise and tied to what has actually happened.
  Internally distinguish stages such as discovery, capture, parsing,
  normalization, ready, no match, and failure, and associate errors with the
  stage that failed. Surface only the detail useful in the current view; do
  not report a native cue failure as a network failure or describe a
  candidate URL as a successfully captured transcript.
- Treat repeated user actions as resume/refresh or a deliberate retry, not as
  accidental duplicate operations. A running operation should be visible and
  not produce an unexplained "already running" dead end. If CDP is used,
  pause/resume should control the intended monitoring session rather than
  create conflicting sessions. Fetching a known candidate directly should
  attempt that candidate even if independent CDP monitoring is active; errors
  should identify an actual overlapping retrieval or failed request, not
  substitute a generic CDP-running message.
- Preserve discovered candidates and completed usable payloads across popup
  closure and background worker suspension, using an appropriate durable
  source of truth. Define expiration/cleanup deliberately; do not assume
  in-memory maps are durable.
- Deduplicate by stable identity such as URL while preserving aliases and
  payload associations. If passive discovery and CDP refer to the same
  resource, the user-visible candidate must still resolve to the captured
  body.
- Avoid false success: no header-only export, no generic JSON accepted
  without timed cue structure, and no visible-caption evidence presented as a
  complete transcript.
- Work through multiple evidence-based paths rather than depending on one
  streaming service's implementation details.

These are product goals, not a mandate to adopt a particular storage,
messaging, or state-management architecture. Choose the least complex
architecture that meets the lifecycle and recovery requirements.

## Investigation and implementation strategy

Make progress in observable stages; do not change several uncertain parts at
once.

1. **Investigate the remaining non-CDP retrieval gap.** Automatic,
   incremental candidate discovery while the popup stays open is now
   user-confirmed for YouTube, Amazon, and Tubi. Do not spend the next
   increment trying to reproduce the earlier repeated-click discovery
   symptom unless it returns. Instead, for a known likely candidate, record
   the redacted host/path, request context, response status and MIME type when
   available, exact stage-specific error, and whether the body validates as
   timed text. Re-test popup close/reopen separately to establish whether
   incremental candidates persist. Test CDP/debugger scope only if needed to
   answer a specific question; do not make its disruptive lifecycle the main
   investigation path.
2. **Define state and invariants before editing.** Specify what identifies a
   capture, which component owns each state, allowed transitions, retry and
   cancellation behavior, candidate identity/merging, persistence boundaries,
   and how a popup obtains a snapshot and subsequent updates. Do not treat
   button clicks or popup-local flags as authoritative progress.
3. **Fix lifecycle/state independently of provider heuristics.** Make
   background work observable and recoverable, and make popup reopening
   idempotently render the existing state. Avoid broadening URL/body matching
   in the same change unless a reproduced failure proves it necessary.
4. **Validate state with deterministic lifecycle cases.** Verify open-popup
   updates, close/reopen restoration, duplicate-click handling, completion,
   failure/retry, page reload, and worker restart. Confirm a captured body
   remains accessible through the visible candidate identity.
5. **Improve non-CDP discovery and retrieval one evidenced gap at a time.**
   Passive resource observation now streams likely candidates into popup
   state, and its automatic incremental behavior is confirmed in live browser
   use on YouTube, Amazon, and Tubi. Preserve this milestone with regression
   coverage. Focus the next implementation on the separately unresolved
   retrieval/validation stage, comparing the known Amazon and Tubi failures
   with YouTube's previously successful download. Determine whether the
   failure is in request context, browser policy, response reading, parsing,
   or another specific stage before changing behavior. Add the smallest
   service-agnostic capability justified by evidence; do not broaden provider
   heuristics as a proxy for a fetch problem.
6. **Re-test representative providers without CDP first.** At minimum
   exercise passive/native discovery, direct retrieval, and structured JSON
   normalization with Prime Video, Tubi, YouTube, and Pluto as available.
   Use CDP only as an explicit fallback or comparison when it is necessary to
   distinguish whether a request/body exists; do not spend effort optimizing
   that fallback before the non-CDP path is understood. Do not claim
   cross-service support from a single successful provider.
7. **Update this note with evidence and decisions.** Clearly mark each item
   as confirmed, disproven, or still unknown. Do not silently turn a
   hypothesis into a fact.

## Technical constraints and cautions

- CDP observation must be armed before the request or replay/reload. It cannot
  reliably recover a response that completed before the watcher attached.
- Do not finish capture on the first generic JSON or first matching response.
  Timed text may arrive later. Record the observation window, response/body
  read counts, accepted candidate, and rejection reasons.
- Generic player/config JSON can precede a valid timed-text response. Validate
  actual timed-event structure, not just URL extension, data-URL labels,
  response MIME type, or inferred format. Reject known non-caption MIME types
  such as fonts, and require a format-specific body signature plus usable cue
  structure before assigning a high-confidence caption candidate. JSON is
  only a caption source when its structure contains actual timed text; JSON
  metadata is not.
- Resource Timing may not expose a request owned by another frame/context or
  otherwise unavailable to the inspected document. Missing timing evidence
  does not establish that no caption request occurred.
- Native extraction is useful when cue lists are actually populated. Report
  track mode, readiness, source presence, and cue counts; reject zero-cue
  output as empty/unavailable rather than success.
- A caption-like DOM overlay contains at most currently rendered text and is
  not a complete transcript or a reliable source of cue timing. Realtime
  sampling would be a separate, opt-in capability with different limits.
- Report stage-specific failures. Distinguish discovery, fetch/CORS, CDP
  attachment/body read, parsing, empty cues, persistence, and UI
  synchronization. A timeout should reflect the actual operation deadline,
  not be returned immediately merely because CDP work is active; direct
  retrieval of a known candidate must not be blocked or mislabeled as an
  overlapping CDP capture.
- A Chrome debugger warning banner is evidence that Chrome regards the
  extension as debugging a target, not sufficient evidence of which tabs are
  attached, which requests are observed, or whether monitoring continues
  after reload/pause. Verify debugger attach/detach events and tab IDs rather
  than inferring scope from the banner.
- Redact signed/query tokens and other secrets from logs. Use short,
  non-sensitive previews only when necessary to diagnose rejected bodies.
  Never commit full caption bodies or account-specific data.

## Safe evidence checklist for provider tests

Record only:

- Service and title at a high level.
- Source type and detected format.
- Redacted host/path, MIME type, and HTTP status.
- The evidence supporting the candidate format/confidence (body signature
  and cue validation, not only URL or MIME hints).
- Whether the body was fetched/read and how it was obtained (native, direct
  fetch, passive evidence, or CDP).
- Cue count and whether cue timing appears absolute or playback-relative.
- Relevant CDP response/body-read counters and the stage/result of parsing.
- Whether the popup state survived open-popup updates, popup reopen, reload,
  and worker restart.

Do not record full signed URLs, request headers, credentials, personal
account data, or full caption payloads.
