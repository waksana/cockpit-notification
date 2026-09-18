# Cockpit Notification 0.1.1 (development)

Trial of revisioned unread deltas; not released, installed or deployed.
Requires a paired host with generic module SSE payload support; released Cockpit 0.2.3
does not provide this capability. The exact host source is pinned in `tooling/host-sdk.json`.
The module manifest and backend API remain v1.

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
- READ now broadcasts an actual ledger delta to connected clients; no extra SSE connection,
  persistent event replay, per-event ACK, background poller or clearing push is added.

## Preserved behavior

- Memory-only unread identities for new primary-agent final replies and current ask requests.
  Stable identities handle repeated events, multi-client reads and reads arriving before insertion.
- One complete snapshot drives message redlines, session counts and the global total.
  Entering a chat does not clear unread; foreground presentation is required.
- Real message, session-status, navigation and management-header middleware without empty slots
  or framework HTML wrappers. Notification policy and requests stay in registered module state.
- Batch read acknowledgements and on-demand recovery; no background poller.
- Web Push delayed by three seconds by default, with bounded sends and cancellation of unsent work.
  VAPID and device subscriptions persist privately; the unread ledger itself does not persist.
- A narrow-scope module worker manages notification identities and supported app badges,
  without controlling Chat, proxying requests or creating an offline cache.
- Explicit device permission/subscription actions, failure reporting, native dialog focus restoration
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

Publication requires separate authorization and exact-source package verification.
This trial does not enable subscriptions, backfill unread history, deploy or restart a service.
