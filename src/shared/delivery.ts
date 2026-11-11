import { record } from './protocol.ts';

export type SendOutcome = 'ACCEPTED' | 'FAILED' | 'UNKNOWN';
export type NetworkCategory = 'dns' | 'destination-blocked' | 'tls' | 'timeout' | 'connection' | 'aborted' | 'other';
export interface SendResult {
  outcome: SendOutcome;
  phase: 'preparation' | 'transport' | 'response' | 'cancelled';
  upstreamStatus?: number;
  retryAfterSeconds?: number;
  networkCategory?: NetworkCategory;
}
export interface DeliveryAttempt {
  at: number;
  result: SendResult;
  invalidation?: 'removed' | 'superseded' | 'persistence-failed';
}
export interface DeliveryStatus {
  latest: DeliveryAttempt;
  lastFailure?: DeliveryAttempt;
  lastAcceptedAt?: number;
}

// Copy only bounded diagnostic fields, never arbitrary sender/response properties.
export function parseSendResult(value: unknown): SendResult {
  if (!record(value) || typeof value.outcome !== 'string' || typeof value.phase !== 'string' ||
      !['ACCEPTED', 'FAILED', 'UNKNOWN'].includes(value.outcome) ||
      !['preparation', 'transport', 'response', 'cancelled'].includes(value.phase)) {
    throw new Error('Invalid push result');
  }
  const outcome = value.outcome as SendOutcome;
  const phase = value.phase as SendResult['phase'];
  if (phase === 'response') {
    if (!Number.isInteger(value.upstreamStatus) || Number(value.upstreamStatus) < 100 ||
        Number(value.upstreamStatus) > 599 ||
        outcome !== (Number(value.upstreamStatus) >= 200 && Number(value.upstreamStatus) < 300 ? 'ACCEPTED' : 'FAILED')) {
      throw new Error('Invalid push response status');
    }
  } else if (value.upstreamStatus !== undefined || outcome !== (phase === 'preparation' ? 'FAILED' : 'UNKNOWN')) {
    throw new Error('Invalid push phase outcome');
  }
  if (value.retryAfterSeconds !== undefined && (phase !== 'response' ||
      !Number.isInteger(value.retryAfterSeconds) || Number(value.retryAfterSeconds) < 0 ||
      Number(value.retryAfterSeconds) > 86400)) throw new Error('Invalid push retry delay');
  if (value.networkCategory !== undefined && (phase !== 'transport' && phase !== 'cancelled' ||
      typeof value.networkCategory !== 'string' ||
      !['dns', 'destination-blocked', 'tls', 'timeout', 'connection', 'aborted', 'other'].includes(value.networkCategory))) {
    throw new Error('Invalid push network category');
  }
  return { outcome, phase,
    ...(value.upstreamStatus === undefined ? {} : { upstreamStatus: Number(value.upstreamStatus) }),
    ...(value.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: Number(value.retryAfterSeconds) }),
    ...(value.networkCategory === undefined ? {} : { networkCategory: value.networkCategory as NetworkCategory }) };
}

export function parseDeliveryStatus(value: unknown): DeliveryStatus {
  function attempt(value: unknown): DeliveryAttempt {
    if (!record(value) || !Number.isSafeInteger(value.at) || Number(value.at) < 0 ||
        value.invalidation !== undefined && (typeof value.invalidation !== 'string' ||
          !['removed', 'superseded', 'persistence-failed'].includes(value.invalidation))) {
      throw new Error('Invalid push delivery attempt');
    }
    return { at: Number(value.at), result: parseSendResult(value.result),
      ...(value.invalidation === undefined ? {} : { invalidation: value.invalidation as DeliveryAttempt['invalidation'] }) };
  }
  if (!record(value) || value.lastAcceptedAt !== undefined &&
      (!Number.isSafeInteger(value.lastAcceptedAt) || Number(value.lastAcceptedAt) < 0)) throw new Error('Invalid push delivery status');
  return { latest: attempt(value.latest),
    ...(value.lastFailure === undefined ? {} : { lastFailure: attempt(value.lastFailure) }),
    ...(value.lastAcceptedAt === undefined ? {} : { lastAcceptedAt: Number(value.lastAcceptedAt) }) };
}
