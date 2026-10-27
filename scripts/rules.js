export const MODULE_ID = "hero-point-handle-bars";
export const COOLDOWN_MS = 60 * 60 * 1000;
export const HERO_POINT_PATH = "system.resources.heroPoints.value";

export class GiftError extends Error {}

export function emptyState() {
  return { version: 1, cooldownUntil: 0, received: [], round: 1, pending: null };
}

/** Offline players still take part; unassigned accounts, banned users and GMs do not. */
export function eligiblePlayers(users) {
  return Array.from(users).filter(user => !user.isGM && !user.isBanned
    && user.character?.type === "character");
}

export function normalizeState(value, players) {
  const ids = new Set(players.map(user => user.id));
  let received = [...new Set(Array.isArray(value?.received) ? value.received : [])]
    .filter(id => ids.has(id));
  let round = Number.isSafeInteger(value?.round) && value.round > 0 ? value.round : 1;
  if (ids.size && received.length === ids.size) {
    received = [];
    round += 1;
  }
  return {
    version: 1,
    cooldownUntil: Number.isFinite(value?.cooldownUntil) ? value.cooldownUntil : 0,
    received,
    round,
    pending: value?.pending ?? null
  };
}

/** Resolve by assigned character, never by ambiguous OWNER permissions. */
export function recipientForToken(token, players) {
  if (!token || token.documentName !== "Token" || !token.actor) {
    throw new GiftError("Target exactly one player character token first.");
  }
  if (!token.actorLink) {
    throw new GiftError("The target must be a linked character token so its Hero Points stay in sync.");
  }
  const matches = players.filter(user => user.character?.id === token.actor.id);
  if (matches.length !== 1) {
    throw new GiftError("The target must be the assigned character of exactly one non-GM player.");
  }
  return matches[0];
}

export function planGift({ state, donor, recipient, actor, players, now }) {
  if (!donor?.active || donor.isBanned) throw new GiftError("The gifting user is no longer connected.");
  if (!players.some(user => user.id === recipient?.id)) throw new GiftError("That player is not eligible to receive a coin.");
  if (donor.id === recipient.id) throw new GiftError("You can only gift a Hero Point to another player.");
  if (actor?.id !== recipient.character?.id || actor.type !== "character") {
    throw new GiftError("The target is no longer that player's assigned character.");
  }
  const current = normalizeState(state, players);
  if (current.pending) throw new GiftError("Another coin is being processed. Please try again shortly.");
  if (!donor.isGM) {
    if (!players.some(user => user.id === donor.id)) throw new GiftError("Assign yourself a player character before gifting a coin.");
    if (current.cooldownUntil > now) {
      const minutes = Math.ceil((current.cooldownUntil - now) / 60000);
      throw new GiftError(`The shared coin cooldown has ${minutes} minute${minutes === 1 ? "" : "s"} remaining.`);
    }
    if (current.received.includes(recipient.id)) {
      throw new GiftError("That player has already received a coin this round. Let every player receive one first.");
    }
  }
  const resource = actor.system?.resources?.heroPoints;
  if (!Number.isInteger(resource?.value) || !Number.isInteger(resource?.max) || resource.max <= 0) {
    throw new GiftError("That character does not have a usable PF2E Hero Point resource.");
  }
  if (resource.value >= resource.max) throw new GiftError("That character already has the maximum number of Hero Points.");
  const nextState = { ...current };
  if (!donor.isGM) {
    nextState.cooldownUntil = now + COOLDOWN_MS;
    nextState.received = [...current.received, recipient.id];
    if (players.every(user => nextState.received.includes(user.id))) {
      nextState.received = [];
      nextState.round += 1;
    }
  }
  return { before: resource.value, after: resource.value + 1, nextState };
}

export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}
