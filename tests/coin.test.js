import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

async function setup(t, { ready = true, showError = false, displayed = true, preload = true } = {}) {
  const hooks = new Map();
  const calls = { hooks: [], images: [], canvases: [], systems: [], presets: [], preloads: [], shows: [], warnings: [] };
  const globals = {
    Hooks: {
      once(name, callback) {
        calls.hooks.push(name);
        hooks.set(name, callback);
      }
    },
    game: { user: { id: "local-viewer" } },
    Image: class {
      naturalWidth = 400;
      naturalHeight = 200;

      set src(value) {
        if (!value) return;
        calls.images.push(value);
        queueMicrotask(() => value.startsWith("missing:") ? this.onerror() : this.onload());
      }
    },
    document: {
      createElement(tag) {
        assert.equal(tag, "canvas");
        const canvas = {
          getContext(type) {
            assert.equal(type, "2d");
            return {
              beginPath() {}, arc() {}, fill() {}, save() {}, clip() {},
              drawImage() {}, restore() {}, stroke() {}
            };
          },
          toBlob(callback, type) {
            assert.equal(type, "image/png");
            callback(new Blob(["portrait"], { type }));
          }
        };
        calls.canvases.push(canvas);
        return canvas;
      }
    },
    addEventListener() {}
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  let urlSequence = 0;
  t.mock.method(URL, "createObjectURL", () => `blob:portrait-${++urlSequence}`);
  t.mock.method(URL, "revokeObjectURL", () => {});
  t.mock.method(console, "warn", (...args) => calls.warnings.push(args));
  const api = {
    addSystem: (...args) => calls.systems.push(args),
    addDicePreset: (...args) => calls.presets.push(args),
    show: async (...args) => {
      calls.shows.push(args);
      if (showError) throw new Error("WebGL unavailable");
      return displayed;
    }
  };
  if (preload) api.preloadPresets = async (systemId) => calls.preloads.push(systemId);
  // Query strings isolate module-level portrait and gift caches between tests.
  const module = await import(`../scripts/coin.js?test=${++importSequence}`);
  module.registerCoinHooks();
  if (ready) hooks.get("diceSoNiceReady")(api);
  return { module, calls, api, hooks };
}

test("coins are optional before Dice So Nice becomes ready", async (t) => {
  const { module, calls } = await setup(t, { ready: false });
  assert.equal(await module.showGiftCoin({ id: "gift", tokenImage: "token.svg" }), false);
  assert.deepEqual(calls.images, []);
  assert.deepEqual(calls.shows, []);
  assert.deepEqual(calls.warnings, []);
});

test("ready hooks register once and a gift uses a local portrait d2", async (t) => {
  const { module, calls } = await setup(t);
  module.registerCoinHooks();
  assert.deepEqual(calls.hooks, ["diceSoNiceReady"]);
  assert.equal(await module.showGiftCoin({ id: "gift", recipientName: "Hero", tokenImage: "token.svg" }), true);
  assert.equal(calls.canvases[0].width, 256);
  assert.equal(calls.canvases[0].height, 256);
  const [system, mode] = calls.systems[0];
  const [preset, shape] = calls.presets[0];
  assert.equal(mode, "default");
  assert.equal(preset.system, system.id);
  assert.equal(preset.type, "d2");
  assert.equal(shape, "d2");
  assert.deepEqual(preset.labels, ["blob:portrait-1#.png", "blob:portrait-1#.png"]);
  assert.deepEqual(calls.preloads, [system.id]);
  const [data, author, synchronize] = calls.shows[0];
  assert.equal(author.id, "local-viewer");
  assert.equal(synchronize, false, "the gift broadcast already reaches every client");
  const die = data.throws[0].dice[0];
  assert.equal(die.type, "d2");
  assert.equal(die.resultLabel, "Hero");
  assert.equal(die.options.appearance.system, system.id);
});

test("concurrent gifts reuse the same portrait registration", async (t) => {
  const { module, calls } = await setup(t);
  const gifts = ["first", "second"].map((id) => module.showGiftCoin({ id, tokenImage: "token.webp" }));
  assert.deepEqual(await Promise.all(gifts), [true, true]);
  assert.deepEqual(calls.images, ["token.webp"]);
  assert.equal(calls.systems.length, 1);
  assert.equal(calls.presets.length, 1);
  assert.equal(calls.preloads.length, 1);
  assert.equal(calls.shows.length, 2);
});

test("duplicate gift delivery is suppressed while its animation is pending", async (t) => {
  const { module, calls } = await setup(t);
  const gift = { id: "one-gift", tokenImage: "token.png" };
  const first = module.showGiftCoin(gift);
  assert.equal(await module.showGiftCoin(gift), false);
  assert.equal(await first, true);
  assert.equal(await module.showGiftCoin(gift), false);
  assert.equal(calls.shows.length, 1);
});

test("unavailable artwork is a cosmetic failure and another gift can recover", async (t) => {
  const { module, calls } = await setup(t);
  assert.equal(await module.showGiftCoin({ id: "broken", tokenImage: "missing:token.png" }), false);
  assert.equal(calls.warnings.length, 1);
  assert.equal(calls.shows.length, 0);
  assert.equal(await module.showGiftCoin({ id: "working", tokenImage: "token.png" }), true);
  assert.equal(calls.shows.length, 1);
});

test("Dice So Nice rendering errors do not reject an already successful gift", async (t) => {
  const { module, calls } = await setup(t, { showError: true });
  assert.equal(await module.showGiftCoin({ id: "gift", tokenImage: "token.png" }), false);
  assert.equal(calls.warnings.length, 1);
});

test("disabled rendering returns false without warning", async (t) => {
  const { module, calls } = await setup(t, { displayed: false });
  assert.equal(await module.showGiftCoin({ id: "gift", tokenImage: "token.png" }), false);
  assert.equal(calls.warnings.length, 0);
});

test("older Dice So Nice versions can load portraits lazily without preloadPresets", async (t) => {
  const { module, calls } = await setup(t, { preload: false });
  assert.equal(await module.showGiftCoin({ id: "gift", tokenImage: "token.png" }), true);
  assert.equal(calls.shows.length, 1);
});
