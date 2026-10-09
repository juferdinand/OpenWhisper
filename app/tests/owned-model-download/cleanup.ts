export interface CleanupEffects {
  readonly creationConfirmed: boolean;
  capture(): Promise<void>;
  remove(): Promise<void>;
  absence(): Promise<void>;
  originalsClosed(): Promise<void>;
}
export interface CleanupReceipt {
  readonly evidenceCaptured: boolean;
  readonly removalReturned: boolean;
  readonly absenceObserved: boolean;
  readonly originalCLIClosuresObserved: boolean;
  readonly namespaceCleanupConfirmed: boolean;
}
/** Cleanup actions are separately bounded/supervised by the caller. A failed
 * original CLI/copy never skips exact-name removal or creates a certificate. */
export async function cleanupOwnedNamespace(effects: CleanupEffects): Promise<CleanupReceipt> {
  const attempt = async (effect: () => Promise<void>): Promise<boolean> => { try { await effect(); return true; } catch { return false; } };
  const evidenceCaptured = await attempt(() => effects.capture());
  const removalReturned = await attempt(() => effects.remove());
  const absenceObserved = await attempt(() => effects.absence());
  const originalCLIClosuresObserved = await attempt(() => effects.originalsClosed());
  return Object.freeze({ evidenceCaptured, removalReturned, absenceObserved, originalCLIClosuresObserved,
    namespaceCleanupConfirmed: effects.creationConfirmed && removalReturned && absenceObserved && originalCLIClosuresObserved });
}
