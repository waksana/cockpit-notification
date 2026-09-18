# Cockpit Notification 0.1.9

## Changes from 0.1.8

- Cap the theme radius at 3px for compact message highlights.
- Shorten read-removal fading to 1600ms, retaining the classic ease-out curve
  (`cubic-bezier(0, 0, 0.58, 1)`) and reduced-motion support.
- Color, layout and unread state semantics remain unchanged.

## Earlier 0.1.8 changes from 0.1.7

The radius and duration below describe 0.1.8 and are superseded by the refinement above.

- Follow the host radius token for rounded unread backgrounds without changing layout.
- Show new unread highlights immediately, blending 35% theme accent with 65% warm gold
  (`#f2c94c`) at 18% opacity over the existing light/dark surface.
- Retain the highlight while unread; fade over 2400ms ease-out only after authoritative
  removal. Reduced-motion preferences still disable transitions.
- Inspired by the [Yellow Fade Technique](https://signalvnoise.com/archives/000558.php);
  the duration and colors here are module choices, not claims about another site's settings.

## Release contract

Revisioned unread deltas are accepted product behavior, no longer a trial.
Release assets must come from the successful CI artifact for the exact tagged main commit.
This document describes the 0.1.9 source target, not proof of publication or deployment.
Pairs with Cockpit 0.2.4 for generic module SSE payloads and menu registration v1;
the historical Cockpit 0.2.3 Release does not provide these capabilities.
The SDK type baseline remains the exact clean development commit pinned in `tooling/host-sdk.json`,
whose APIs are included unchanged in Cockpit 0.2.4.
The module manifest and backend API remain v1.

## Installation identity

0.1.9 packages smaller corners and a 1600ms ease-out fade under a new immutable version.
It does not replace an already installed 0.1.8 digest. The earlier package
and device configuration are retained; the unread protocol and restart semantics are unchanged.

## Earlier 0.1.7 changes from 0.1.6

The following appearance settings describe 0.1.7; 0.1.8 supersedes its color and duration
with the refinement above while retaining its integration and state semantics.

- Replace the out-of-bounds reply redline with a subtle background painted inside the actual
  message body, only for completed primary-agent replies known to be unread.
  Mix the theme token `--ck-color-accent` at 8% with transparency, adapting to light and dark themes.
- Use the public `MessageProps.className` styling hook; retain incoming classes and `style`,
  compose `bodyRef`, and preserve children/adornment and accessibility props.
  Replace the decorative line with a visually hidden unread label, retaining
  `role="img"` and `aria-label="未读消息"`;
  remove decorative-line measurement and its ResizeObserver.
  No extra DOM wrappers, decoration nodes, padding, margins or layout changes are introduced.
- Fade the background out over 200ms when unread is removed; disable transitions under
  `prefers-reduced-motion`.
- Paint inside the body to avoid clipping of out-of-bounds decoration by `content-visibility: auto`.
  No host changes or performance-optimization opt-out are required.
- Ask requests remain unhighlighted, counted and observed for reading. Session count badges,
  menu registration, ledger/delta protocol, reading rules, push and subscriptions are unchanged.

The following sections record earlier releases' changes; their redline descriptions are historical
and are superseded by the 0.1.7 background above.

## Changes from 0.1.5

- Center session unread counts in an 18px-high, border-box inline-flex badge. A
  single digit is circular; larger counts expand horizontally into a pill without
  flex shrinking. Preserve the host's trailing badge placement and noninteractive semantics.
- No changes to menu registration, reading detection, ledger/deltas, push delivery or subscriptions.

## Changes from 0.1.4

- Register the device toggle through `menus` (`context.menuVersion === 1`), not a
  `globalNavigation` component wrapper. The host retains native commands and owns
  menu ordering, separators, keyboard operation, closing and focus restoration.
- Derive presentation and subscriptions directly from DeviceBridge; keep its existing
  permission, subscription, backend registration, concurrency and failure handling.
  Browser-only subscriptions still allow retrying a failed backend registration.
- Preserve message reading/bodyRef and session-status middleware, unread timing,
  WNS endpoints and the narrow-worker click fix. No second notification entry is added.

## Retained changes from 0.1.3

- A notification click focuses an already open exact-session window, preferring a focused match.
  Otherwise it calls `clients.openWindow()`; browser/PWA policy determines window reuse.
- Never call `WindowClient.navigate()` on a chat page outside the notification worker's control.
  An activated registration and `includeUncontrolled` enumeration do not grant that control.
- Retain the narrow worker scope, existing subscriptions/permissions, safe target validation and
  click-without-READ behavior. Opening/focus failures remain explicit, without blind retries,
  scope expansion, `clients.claim()` or a second page-navigation protocol.

## Changes from 0.1.2

- Accept Microsoft WNS HTTPS endpoints under `.notify.windows.com`, including changing service
  subdomains, without allowing arbitrary Windows domains or lookalike suffixes. Existing
  port/credential/fragment/length guards and send-time public-address checks remain in force.
- A browser-created subscription does not mean the backend registered it. Keep the enable action
  available after a rejected registration so an explicit retry can reuse that subscription.
- Existing server-side device subscriptions and VAPID keys are preserved. No automatic device
  permission prompts, real push experiments or replay of previously unknown sends.

## Changes from 0.1.0

- Treat provider `apiCallId` as an opaque SDK string instead of a bounded message identity.
  Long provider IDs must not suppress an otherwise valid final reply.
- Publish atomic unread additions/removals through the existing SSE connection as generic module payloads.
  The host routes JSON, without interpreting unread policy or versions.
- Read GET snapshots and contiguous deltas are the only sources of visible unread state.
  HTTP read receipts carry acknowledged keys and a version checkpoint, not a snapshot.
- Switching sessions no longer fetches unread state. Initialization, reconnect, generation changes,
  gaps, oversized deltas and an uncovered receipt checkpoint recover through a full snapshot.
- Buffer snapshot/delta races within a bound; ignore covered duplicates. Querying does not advance revision.
- Versioned push hints do not unconditionally repeat a GET already covered by SSE.
- The hamburger menu contains only an enable/disable action for this device's notifications.
  Remove the standalone bell/global unread total, settings dialog and management-header entries.
  Per-session unread badges appear after the native status text, at the right end of the row.
  The paired host uses a single pending-answer label instead of replying plus a separate decision marker.
- READ now broadcasts an actual ledger delta to connected clients; no extra SSE connection,
  persistent event replay, per-event ACK, background poller or clearing push is added.
- Ask/questionnaire components no longer display unread redlines. Their message middleware still
  observes stable foreground presentation and reports the exact request identity as read, without answering.
  Reply redlines and unread counting/push behavior remain unchanged.
- Notifications use "新回复：session title" or "待回答：session title" with a bounded plain-text excerpt
  from the final reply or current question. No model summarization or history fetch is added.
  Excerpts stay out of unread snapshots/deltas and server persistence; device notification previews may expose them.
  Notification clicks retain exact-session navigation and never mark the session read or answer a question.
  Browser/OS application attribution is not part of the module's title or body and cannot be removed by it.

## Preserved behavior

- Memory-only unread identities for new primary-agent final replies and current ask requests.
  Stable identities handle repeated events, multi-client reads and reads arriving before insertion.
- A complete snapshot followed by contiguous deltas drives reply unread highlights, session counts and the internal total for app badges.
  Entering a chat does not clear unread; foreground presentation is required.
- Real message/session-status middleware and declarative menu commands without empty slots
  or framework HTML wrappers. Notification policy and requests stay in registered module state.
- Batch read acknowledgements and on-demand recovery; no background poller.
- Web Push delayed by three seconds by default, with bounded sends and cancellation of unsent work.
  VAPID and device subscriptions persist privately; the unread ledger itself does not persist.
- A narrow-scope module worker manages notification identities and supported app badges,
  without controlling Chat, proxying requests or creating an offline cache.
- Explicit device permission/subscription actions, failure reporting, native menu focus restoration
  and correct subpixel viewport handling.

## Compatibility and limits

- Requires the paired host; earlier Web module slots are not supported.
- Node 24.20.0, pnpm 10.34.5; fixed native SDK 1.0.13 / runtime 1.0.83 / protocol 3.
- Restart establishes a fresh unread generation and forgets old unread entries; no historical backfill.
- Unphased final replies use the agreed structural compatibility rule, not a perfect provider-independent classifier.
- Other clients and sleeping devices may retain stale counts/notifications until their next successful synchronization.
  Already-sent notifications can arrive late; push delivery and instant notification retraction are not guaranteed.
- Real iPhone/Android installed-PWA push delivery has not been established by the synthetic fixtures.
  Platform installation, permission, network and operating-system limits still apply.

Source changes do not automatically publish a Release, enable subscriptions, backfill unread history,
deploy or restart a service. Release assets and each installation retain their exact source identities.
