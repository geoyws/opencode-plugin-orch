import type { Store } from "../state/store.js";

export class Scratchpad {
  constructor(private store: Store) {}

  set(teamID: string, key: string, value: string): void {
    this.store.scratchpadSet(teamID, key, value);
  }

  get(teamID: string, key: string): string | undefined {
    return this.store.scratchpadGet(teamID, key);
  }

  delete(teamID: string, key: string): void {
    this.store.scratchpadDelete(teamID, key);
  }

  list(teamID: string): Record<string, string> {
    return this.store.scratchpadList(teamID);
  }
}
