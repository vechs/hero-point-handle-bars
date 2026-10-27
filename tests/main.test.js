import test from "node:test";
import assert from "node:assert/strict";
import { MODULE_ID, HERO_POINT_PATH } from "../scripts/rules.js";

test("Foundry lifecycle wires H and Socketlib into a GM-context award with no approval dialog", async t => {
  const callbacks = new Map();
  const events = new Map();
  const original = new Map();
  const install = (name, value) => {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const on = (name, fn) => callbacks.set(name, [...(callbacks.get(name) ?? []), fn]);
  const emit = (name, ...args) => { for (const fn of callbacks.get(name) ?? []) fn(...args); };
  install("Hooks", { once: on, on });
  install("addEventListener", (name, fn) => events.set(name, fn));
  install("setInterval", () => 1);
  install("clearInterval", () => {});
  install("document", { activeElement: null });
  const warnings = [];
  install("ui", { notifications: { warn: value => warnings.push(value), info: () => {} } });
  let lastGift;
  const actor = {
    id: "actor-b", uuid: "Actor.actor-b", type: "character",
    system: { resources: { heroPoints: { value: 1, max: 3 } } },
    getFlag: () => lastGift,
    async update(changes) {
      assert.equal(game.user.id, "gm", "the Actor write must run in the GM's context");
      this.system.resources.heroPoints.value = changes[HERO_POINT_PATH];
      lastGift = changes[`flags.${MODULE_ID}.lastGift`];
      return this;
    }
  };
  const token = { documentName: "Token", uuid: "Scene.scene.Token.token", actorLink: true,
    actor, parent: { id: "scene" }, texture: { src: "portrait.webp" } };
  const gm = { id: "gm", name: "GM", isGM: true, active: true, viewedScene: "scene", targets: new Set() };
  const a = { id: "a", name: "Alice", isGM: false, active: true, viewedScene: "scene",
    character: { id: "actor-a", type: "character" }, targets: new Set() };
  const b = { id: "b", name: "Bob", isGM: false, active: true, character: actor };
  const users = [gm, a, b];
  users.get = id => users.find(user => user.id === id);
  users.activeGM = gm;
  const values = new Map();
  const settings = new Map();
  let binding;
  const module = {};
  install("game", {
    ready: false, user: a, users, system: { id: "pf2e" }, messages: [],
    modules: new Map([[MODULE_ID, module]]),
    settings: {
      register: (_module, key, definition) => {
        settings.set(key, definition);
        values.set(key, key === "showHand" ? false : structuredClone(definition.default));
      },
      get: (_module, key) => values.get(key),
      set: async (_module, key, value) => values.set(key, value)
    },
    keybindings: { register: (_module, _key, definition) => { binding = definition; } }
  });
  const functions = new Map();
  const routes = [];
  install("socketlib", { registerModule: () => ({
    register: (name, fn) => functions.set(name, fn),
    async executeAsUser(name, userId, request) {
      const caller = game.user;
      routes.push({ userId, callerId: caller.id });
      game.user = users.get(userId);
      try { return await functions.get(name).call({ socketdata: { userId: caller.id } }, request); }
      finally { game.user = caller; }
    }
  }) });
  install("fromUuid", async uuid => uuid === token.uuid ? token : uuid === actor.uuid ? actor : null);
  let requestNumber = 0;
  install("foundry", {
    data: { fields: { NumberField: class NumberField {
      constructor(options) { this.options = options; }
    } } },
    utils: { randomID: () => `request-${String(++requestNumber).padStart(16, "0")}` },
    documents: { ChatMessage: { async create(data) {
      assert.equal(game.user.id, "gm");
      const message = { ...data, getFlag: (scope, key) => data.flags[scope][key] };
      game.messages.push(message);
      emit("createChatMessage", message, {}, "gm");
      return message;
    } } }
  });

  await import(`../scripts/main.js?controller-test=${Date.now()}`);
  emit("socketlib.ready");
  emit("init");
  game.ready = true;
  emit("ready");
  assert.equal(settings.get("cooldownMinutes").scope, "world");
  assert.equal(settings.get("cooldownMinutes").config, true);
  assert.equal(values.get("cooldownMinutes"), 60);
  assert.equal(settings.get("cooldownMinutes").type.options.min, 0);
  await game.settings.set(MODULE_ID, "cooldownMinutes", 15);
  assert.deepEqual(binding.editable, [{ key: "KeyH" }]);
  assert.equal(binding.onDown({ event: { target: { closest: () => ({}) } } }), false, "typing must not trigger a gift");
  assert.equal(binding.onDown({ event: { repeat: true } }), false);
  assert.equal((await module.api.gift()).ok, false, "a target is required");
  assert.match(warnings.pop(), /exactly one/);

  a.targets.add({ document: token });
  const playerGift = await module.api.gift();
  assert.equal(playerGift.ok, true);
  assert.equal(playerGift.receipt.donorId, "a");
  assert.equal(actor.system.resources.heroPoints.value, 2);
  assert.deepEqual(routes[0], { userId: "gm", callerId: "a" });
  const state = module.api.getState();
  const remaining = state.cooldownUntil - Date.now();
  assert.ok(remaining > 14 * 60000 && remaining <= 15 * 60000, "the GM uses the configured cooldown");
  assert.deepEqual(state.received, ["b"]);
  state.received.length = 0;
  assert.deepEqual(module.api.getState().received, ["b"], "the public state accessor must return a copy");

  game.user = gm;
  gm.targets.add({ document: token });
  const beforeGMGift = module.api.getState();
  assert.equal((await module.api.gift()).ok, true);
  assert.equal(actor.system.resources.heroPoints.value, 3);
  assert.deepEqual(module.api.getState(), beforeGMGift);
  assert.equal(game.messages.length, 2);
  events.get("pagehide")();
});
