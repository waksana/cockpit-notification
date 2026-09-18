# Cockpit Notification 0.1.2

Revisioned unread deltas are accepted product behavior, no longer a trial.
GitHub Release assets for 0.1.2 have not yet been published; fixed-source installation is separate.
Requires a paired host with generic module SSE payload support; released Cockpit 0.2.3
does not provide this capability. The exact host source is pinned in `tooling/host-sdk.json`.
The module manifest and backend API remain v1.

## Installation identity

0.1.2 packages the accepted notification-content and menu/sidebar refinements under a new
immutable version. It does not replace an already installed 0.1.1 digest. The earlier package
and device configuration are retained; the unread protocol and restart semantics are unchanged.

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
- A complete snapshot followed by contiguous deltas drives reply redlines, session counts and the internal total for app badges.
  Entering a chat does not clear unread; foreground presentation is required.
- Real message, session-status and navigation-menu middleware without empty slots
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
