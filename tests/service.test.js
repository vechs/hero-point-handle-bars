import test from "node:test";
import assert from "node:assert/strict";
import { GiftService } from "../scripts/service.js";
import { MODULE_ID, emptyState, HERO_POINT_PATH, COOLDOWN_MS } from "../scripts/rules.js";

function fixture() {
  let saved = emptyState();
  let time = 1000;
  let cooldownMinutes = 60;
  const errors = [];
  const gm = { id: "gm", name: "GM", active: true, isGM: true, viewedScene: "scene" };
  const a = { id: "a", name: "<Alice>", active: true, viewedScene: "scene", character: { id: "actor-a", type: "character" } };
  const b = { id: "b", name: "Bob", active: true, viewedScene: "scene", character: { id: "actor-b", type: "character" } };
  const c = { id: "c", name: "Ciri", active: true, viewedScene: "scene", character: { id: "actor-c", type: "character" } };
  const users = [gm, a, b, c];
  users.activeGM = gm;
  users.get = id => users.find(user => user.id === id);
  const messages = [];
  let marker;
  let updates = 0;
  const actor = {
    id: b.character.id, type: "character", uuid: "Actor.actor-b", img: "portrait.webp",
    system: { resources: { heroPoints: { value: 1, max: 3 } } },
    getFlag: () => marker,
    async update(data) {
      updates += 1;
      this.system.resources.heroPoints.value = data[HERO_POINT_PATH];
      marker = data[`flags.${MODULE_ID}.lastGift`];
      return this;
    }
  };
  const token = { documentName: "Token", actorLink: true, actor, parent: { id: "scene" }, texture: { src: "token.webp" } };
  const game = {
    user: gm, system: { id: "pf2e" }, users, messages,
    settings: {
      get: (_module, key) => key === "cooldownMinutes" ? cooldownMinutes : structuredClone(saved),
      set: async (_module, _key, value) => { saved = structuredClone(value); }
    }
  };
  const deps = {
    game, resolveUuid: async uuid => uuid === actor.uuid ? actor : uuid === "Scene.scene.Token.token" ? token : null,
    now: () => time, notify: error => errors.push(error),
    createMessage: async data => { const message = { ...data, getFlag: (scope, key) => data.flags[scope][key] }; messages.push(message); return message; }
  };
  const service = new GiftService(deps);
  const request = (id = "request-0000000001") => ({ id, version: 1, tokenUuid: "Scene.scene.Token.token" });
  return { service, deps, game, actor, token, gm, a, b, c, messages, errors, request,
    state: () => saved, setTime: value => { time = value; },
    setCooldown: minutes => { cooldownMinutes = minutes; }, updates: () => updates };
}

test("Socketlib caller identity controls donor and success publishes exactly once", async () => {
  const f = fixture();
  const result = await f.service.handleRequest({ ...f.request(), donorId: "gm" }, "a");
  assert.equal(result.ok, true);
  assert.equal(result.receipt.donorId, "a");
  assert.equal(result.receipt.gmGift, false);
  assert.equal(result.receipt.tokenImage, "token.webp");
  assert.equal(f.actor.system.resources.heroPoints.value, 2);
  assert.equal(f.state().cooldownUntil, 1000 + COOLDOWN_MS);
  assert.deepEqual(f.state().received, ["b"]);
  assert.equal(f.state().pending, null);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].content, /&lt;Alice&gt;/);
});

test("simultaneous requests serialize, so only one player gift succeeds", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.service.handleRequest(f.request(), "a"),
    f.service.handleRequest(f.request("request-0000000002"), "c")
  ]);
  assert.deepEqual(results.map(result => result.ok), [true, false]);
  assert.match(results[1].error, /cooldown/);
  assert.equal(f.updates(), 1);
});

test("configured cooldown applies to future gifts without rewriting an existing expiry", async () => {
  const f = fixture();
  f.setCooldown(15);
  assert.equal((await f.service.handleRequest(f.request(), "a")).ok, true);
  const expiry = 1000 + 15 * 60000;
  assert.equal(f.state().cooldownUntil, expiry);
  f.setCooldown(0);
  const blocked = await f.service.handleRequest(f.request("request-0000000002"), "c");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /cooldown/);
  assert.equal(f.state().cooldownUntil, expiry);
});

test("zero cooldown allows immediate new gifts while preserving recipient rotation", async () => {
  const f = fixture();
  f.setCooldown(0);
  assert.equal((await f.service.handleRequest(f.request(), "a")).ok, true);
  assert.equal(f.state().cooldownUntil, 1000);
  const repeatedRecipient = await f.service.handleRequest(f.request("request-0000000002"), "c");
  assert.equal(repeatedRecipient.ok, false);
  assert.match(repeatedRecipient.error, /already received/);
  assert.deepEqual(f.state().received, ["b"]);
});

test("retrying an existing request does not award twice, including after service restart", async () => {
  const f = fixture();
  await Promise.all([f.service.handleRequest(f.request(), "a"), f.service.handleRequest(f.request(), "a")]);
  const restarted = new GiftService(f.deps);
  assert.equal((await restarted.handleRequest(f.request(), "a")).ok, true);
  assert.equal(f.updates(), 1);
  assert.equal(f.messages.length, 1);
  assert.equal((await f.service.handleRequest(f.request(), "gm")).ok, false);
});

test("unidentified callers, wrong scenes, malformed targets, and NPCs cannot award", async () => {
  for (const mode of ["unknown", "scene", "uuid", "npc"]) {
    const f = fixture();
    if (mode === "scene") f.a.viewedScene = "other-scene";
    if (mode === "npc") f.actor.id = "npc";
    const request = mode === "uuid" ? { ...f.request(), tokenUuid: "Actor.actor-b" } : f.request();
    const result = await f.service.handleRequest(request, mode === "unknown" ? "forged" : "a");
    assert.equal(result.ok, false, mode);
    assert.equal(f.updates(), 0);
    assert.deepEqual(f.state(), emptyState());
  }
});

test("a failed Actor update retains its journal until recovery confirms no point was awarded", async () => {
  const f = fixture();
  f.actor.update = async () => { throw new Error("permission failed"); };
  const result = await f.service.handleRequest(f.request(), "a");
  assert.equal(result.ok, false);
  assert.ok(f.state().pending);
  f.setTime(32000);
  await f.service.recover();
  assert.deepEqual(f.state(), emptyState());
  assert.equal(f.messages.length, 0);
});

test("a delayed server commit after a lost acknowledgement retains cooldown and rotation", async () => {
  const f = fixture();
  const apply = f.actor.update.bind(f.actor);
  let delayedCommit;
  f.actor.update = async data => {
    delayedCommit = () => apply(data);
    throw new Error("lost acknowledgement");
  };
  assert.equal((await f.service.handleRequest(f.request(), "a")).ok, false);
  assert.ok(f.state().pending);
  await delayedCommit();
  f.setTime(32000);
  await f.service.recover();
  assert.equal(f.state().pending, null);
  assert.equal(f.state().cooldownUntil, 1000 + COOLDOWN_MS);
  assert.deepEqual(f.state().received, ["b"]);
  assert.equal(f.actor.system.resources.heroPoints.value, 2);
  assert.equal(f.messages.length, 1);
});

test("a cancelled chat announcement recovers an awarded coin without granting it twice", async () => {
  const f = fixture();
  f.service.createMessage = async () => undefined;
  assert.equal((await f.service.handleRequest(f.request(), "a")).recovering, true);
  assert.ok(f.state().pending);
  f.service.createMessage = f.deps.createMessage;
  f.setTime(32000);
  await f.service.recover();
  assert.equal(f.state().pending, null);
  assert.equal(f.updates(), 1);
  assert.equal(f.messages.length, 1);
});

test("a cancelled Actor update also releases the reservation", async () => {
  const f = fixture();
  f.actor.update = async () => undefined;
  assert.equal((await f.service.handleRequest(f.request(), "a")).ok, false);
  assert.deepEqual(f.state(), emptyState());
});

test("GM gifts can repeat during cooldown without advancing the player rotation", async () => {
  const f = fixture();
  await f.service.handleRequest(f.request(), "a");
  const before = structuredClone(f.state());
  f.setCooldown(5);
  assert.equal((await f.service.handleRequest(f.request("request-0000000002"), "gm")).ok, true);
  assert.deepEqual(f.state(), before);
  assert.equal(f.actor.system.resources.heroPoints.value, 3);
  assert.equal((await f.service.handleRequest(f.request("request-0000000003"), "gm")).ok, false);
});

test("only the active GM may process awards", async () => {
  const f = fixture();
  f.game.user = { id: "second-gm", isGM: true };
  assert.equal((await f.service.handleRequest(f.request(), "a")).ok, false);
  assert.equal(f.updates(), 0);
});

test("a committed award with failed chat delivery recovers without an additional point", async () => {
  const f = fixture();
  const createMessage = f.deps.createMessage;
  f.service.createMessage = async () => { throw new Error("chat offline"); };
  const result = await f.service.handleRequest(f.request(), "a");
  assert.equal(result.ok, true);
  assert.equal(result.recovering, true);
  assert.ok(f.state().pending);
  assert.equal(f.messages.length, 0);
  f.service.createMessage = createMessage;
  await f.service.recover();
  assert.ok(f.state().pending, "do not race an operation that may still be settling");
  f.setTime(32000);
  await f.service.recover();
  assert.equal(f.state().pending, null);
  assert.equal(f.messages.length, 1);
  assert.equal(f.updates(), 1);
});

test("recovery clears a reservation when the GM disconnected before updating the actor", async () => {
  const f = fixture();
  const previousState = emptyState();
  await f.game.settings.set(MODULE_ID, "giftState", {
    ...previousState, cooldownUntil: 3601000, received: ["b"],
    pending: { id: f.request().id, actorUuid: f.actor.uuid, startedAt: 0, previousState }
  });
  f.setTime(31000);
  await f.service.recover();
  assert.deepEqual(f.state(), previousState);
  assert.equal(f.updates(), 0);
});
