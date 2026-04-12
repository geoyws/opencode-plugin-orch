import type { Member, MemberState } from "../state/schemas.js";

// Valid state transitions
const TRANSITIONS: Record<MemberState, MemberState[]> = {
  initializing: ["ready", "error", "shutdown"],
  ready: ["busy", "shutdown_requested", "shutdown", "error"],
  busy: ["ready", "error", "shutdown_requested"],
  shutdown_requested: ["shutdown", "ready"],
  shutdown: [],
  error: ["ready", "shutdown"],
};

export function canTransition(from: MemberState, to: MemberState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionMember(member: Member, to: MemberState): Member {
  if (!canTransition(member.state, to)) {
    throw new Error(
      `Invalid state transition for member ${member.role}: ${member.state} → ${to}`
    );
  }
  return { ...member, state: to };
}

export function isActive(member: Member): boolean {
  return !["shutdown", "error"].includes(member.state);
}

export function isIdle(member: Member): boolean {
  return member.state === "ready";
}

export function isBusy(member: Member): boolean {
  return member.state === "busy";
}

export function stateIcon(state: MemberState): string {
  switch (state) {
    case "initializing":
      return "~";
    case "ready":
      return "○";
    case "busy":
      return "●";
    case "shutdown_requested":
      return "⏻";
    case "shutdown":
      return "×";
    case "error":
      return "!";
  }
}
