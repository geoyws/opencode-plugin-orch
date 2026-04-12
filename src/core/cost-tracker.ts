import type { Store } from "../state/store.js";
import type { CostEntry } from "../state/schemas.js";

export class CostTracker {
  constructor(private store: Store) {}

  record(entry: Omit<CostEntry, "timestamp">): void {
    this.store.addCost({ ...entry, timestamp: Date.now() });
  }

  getMemberCost(memberID: string): number {
    return this.store.getMemberCost(memberID);
  }

  getTeamCost(teamID: string): number {
    return this.store.getTeamCost(teamID);
  }

  isOverBudget(teamID: string, budget: number | undefined): boolean {
    if (budget === undefined) return false;
    return this.getTeamCost(teamID) >= budget;
  }

  formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }
}
