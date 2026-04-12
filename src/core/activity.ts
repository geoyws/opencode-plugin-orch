import type { Activity } from "../state/schemas.js";

export class ActivityTracker {
  private activities = new Map<string, Activity>();

  record(memberID: string, tool: string, target: string): void {
    this.activities.set(memberID, {
      memberID,
      tool,
      target,
      timestamp: Date.now(),
    });
  }

  get(memberID: string): Activity | undefined {
    return this.activities.get(memberID);
  }

  getIdleDuration(memberID: string): number {
    const activity = this.activities.get(memberID);
    if (!activity) return 0;
    return Date.now() - activity.timestamp;
  }

  formatActivity(memberID: string): string {
    const activity = this.activities.get(memberID);
    if (!activity) return "(no activity)";

    const elapsed = Date.now() - activity.timestamp;
    if (elapsed > 5000) {
      return `(idle ${Math.round(elapsed / 1000)}s)`;
    }

    // Truncate target for display
    const target =
      activity.target.length > 30
        ? activity.target.slice(0, 27) + "..."
        : activity.target;

    return `${activity.tool} ${target}`;
  }

  clear(memberID: string): void {
    this.activities.delete(memberID);
  }
}
