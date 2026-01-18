// Tracks client-side speaking submission progress across route changes.
// Stored in sessionStorage so History can render progress without blocking the user.

export type SpeakingSubmissionStage =
  | 'preparing'
  | 'converting'
  | 'uploading'
  | 'queuing'
  | 'evaluating'
  | 'finalizing'
  | 'completed'
  | 'failed';

export interface SpeakingSubmissionTiming {
  conversionMs?: number;
  uploadMs?: number;
  evaluationMs?: number;
  totalMs?: number;
}

export interface SpeakingSubmissionTracker {
  testId: string;
  mode: 'basic' | 'accuracy';
  stage: SpeakingSubmissionStage;
  detail?: string;
  startedAt: number; // epoch ms
  updatedAt: number; // epoch ms
  timing?: SpeakingSubmissionTiming;
  lastError?: string;
}

const storageKey = (testId: string) => `speaking_submission_tracker:${testId}`;

export function getSpeakingSubmissionTracker(testId: string): SpeakingSubmissionTracker | null {
  try {
    const raw = sessionStorage.getItem(storageKey(testId));
    if (!raw) return null;
    return JSON.parse(raw) as SpeakingSubmissionTracker;
  } catch {
    return null;
  }
}

export function setSpeakingSubmissionTracker(testId: string, tracker: SpeakingSubmissionTracker) {
  try {
    sessionStorage.setItem(storageKey(testId), JSON.stringify(tracker));
    window.dispatchEvent(new CustomEvent('speaking-submission-tracker', { detail: { testId, tracker } }));
  } catch {
    // ignore
  }
}

export function patchSpeakingSubmissionTracker(
  testId: string,
  patch: Partial<Omit<SpeakingSubmissionTracker, 'testId'>>
) {
  const existing = getSpeakingSubmissionTracker(testId);
  const now = Date.now();
  const next: SpeakingSubmissionTracker = {
    testId,
    mode: existing?.mode ?? 'basic',
    stage: existing?.stage ?? 'preparing',
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    ...existing,
    ...patch,
    timing: {
      ...(existing?.timing || {}),
      ...(patch.timing || {}),
    },
  };
  setSpeakingSubmissionTracker(testId, next);
}

export function clearSpeakingSubmissionTracker(testId: string) {
  try {
    sessionStorage.removeItem(storageKey(testId));
    window.dispatchEvent(new CustomEvent('speaking-submission-tracker', { detail: { testId, tracker: null } }));
  } catch {
    // ignore
  }
}
