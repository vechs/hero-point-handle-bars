import test from "node:test";
import assert from "node:assert/strict";
import { COOLDOWN_MS, emptyState, eligiblePlayers, normalizeState, recipientForToken, planGift } from "../scripts/rules.js";

function fixture() {
  const players = ["a", "b", "c"].map(id => ({
    id, active: true, isGM: false, character: { id: `actor-${id}`, type: "character" }
  }));
  const actor = { ...players[1].character, system: { resources: { heroPoints: { value: 1, max: 3 } } } };
  return { state: emptyState(), donor: players[0], recipient: players[1], actor, players, now: 1000 };
}

test("a player gift adds exactly one point and starts the party cooldown", () => {
  const input = fixture();
  const plan = planGift(input);
  assert.equal(plan.before, 1);
  assert.equal(plan.after, 2);
  assert.equal(plan.nextState.cooldownUntil, 1000 + COOLDOWN_MS);
  assert.deepEqual(plan.nextState.received, ["b"]);
  assert.deepEqual(input.state, emptyState(), "planning must not mutate state");
});

test("the shared cooldown blocks the giver as well as other players until exactly the deadline", () => {
  const input = fixture();
  input.state.cooldownUntil = input.now + COOLDOWN_MS;
  assert.throws(() => planGift(input), /shared coin cooldown/);
  input.donor = input.players[2];
  assert.throws(() => planGift(input), /shared coin cooldown/);
  input.now = input.state.cooldownUntil;
  assert.equal(planGift(input).after, 2);
});

test("a recipient waits until every eligible player has received one", () => {
  const input = fixture();
  input.state.received = ["b"];
  assert.throws(() => planGift(input), /already received/);
  input.state.received = ["a", "c"];
  const result = planGift(input);
  assert.deepEqual(result.nextState.received, []);
  assert.equal(result.nextState.round, 2);
});

test("GM gifts bypass cooldown and rotation and change neither", () => {
  const input = fixture();
  input.donor = { id: "gm", active: true, isGM: true };
  input.state.cooldownUntil = input.now + COOLDOWN_MS;
  input.state.received = ["b"];
  const result = planGift(input);
  assert.equal(result.after, 2);
  assert.deepEqual(result.nextState, input.state);
});

test("self-gifts, missing character assignments, and disconnected donors are rejected", () => {
  const input = fixture();
  input.donor = input.recipient;
  assert.throws(() => planGift(input), /another player/);
  input.donor = { id: "unassigned", active: true };
  assert.throws(() => planGift(input), /Assign yourself/);
  input.donor = { ...input.players[0], active: false };
  assert.throws(() => planGift(input), /no longer connected/);
});

test("GM gifts still respect the resource cap, including characters whose max is zero", () => {
  const input = fixture();
  input.donor = { id: "gm", active: true, isGM: true };
  input.actor.system.resources.heroPoints.value = 3;
  assert.throws(() => planGift(input), /maximum/);
  input.actor.system.resources.heroPoints = { value: 0, max: 0 };
  assert.throws(() => planGift(input), /usable PF2E/);
});

test("offline assigned players remain eligible; GMs, banned and unassigned accounts do not", () => {
  const { players } = fixture();
  players[2].active = false;
  assert.deepEqual(eligiblePlayers([...players, { id: "gm", isGM: true, character: players[0].character },
    { id: "unassigned" }, { ...players[0], id: "banned", isBanned: true }]).map(user => user.id), ["a", "b", "c"]);
});

test("rotation removes departed users and advances completed rounds after roster changes", () => {
  const { players } = fixture();
  const state = { ...emptyState(), received: ["a", "b", "departed", "a"] };
  assert.deepEqual(normalizeState(state, players).received, ["a", "b"]);
  const normalized = normalizeState(state, players.slice(0, 2));
  assert.deepEqual(normalized.received, []);
  assert.equal(normalized.round, 2);
});

test("recipient resolution requires one assigned non-GM player and a linked character token", () => {
  const { actor, players } = fixture();
  const token = { documentName: "Token", actorLink: true, actor };
  assert.equal(recipientForToken(token, players).id, "b");
  assert.throws(() => recipientForToken({ ...token, actorLink: false }, players), /linked/);
  assert.throws(() => recipientForToken(token, [...players, { ...players[1], id: "duplicate" }]), /exactly one/);
  assert.throws(() => recipientForToken({ ...token, actor: { id: "npc" } }, players), /exactly one/);
});

test("a pending transaction blocks additional gifts, even from GMs", () => {
  const input = fixture();
  input.state.pending = { id: "in-flight" };
  assert.throws(() => planGift(input), /being processed/);
  input.donor = { id: "gm", active: true, isGM: true };
  assert.throws(() => planGift(input), /being processed/);
});
