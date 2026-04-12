import type { Store } from "../state/store.js";
import type { FileLock } from "../state/schemas.js";

export class FileLockManager {
  constructor(private store: Store) {}

  tryAcquire(filePath: string, memberID: string, teamID: string): { ok: boolean; holder?: string } {
    const lock: FileLock = { path: filePath, memberID, teamID, acquiredAt: Date.now() };
    const ok = this.store.acquireLock(lock);
    if (!ok) {
      const existing = this.store.getLock(filePath);
      const holder = existing ? this.store.getMember(existing.memberID)?.role ?? existing.memberID : undefined;
      return { ok: false, holder };
    }
    return { ok: true };
  }

  release(filePath: string): void {
    this.store.releaseLock(filePath);
  }

  releaseAll(memberID: string): void {
    this.store.releaseMemberLocks(memberID);
  }

  isLocked(filePath: string): boolean {
    return this.store.getLock(filePath) !== undefined;
  }

  getHolder(filePath: string): string | undefined {
    const lock = this.store.getLock(filePath);
    if (!lock) return undefined;
    const member = this.store.getMember(lock.memberID);
    return member?.role ?? lock.memberID;
  }

  getMemberLocks(memberID: string): FileLock[] {
    return this.store.getMemberLocks(memberID);
  }
}
