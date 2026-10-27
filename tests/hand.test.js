import assert from "node:assert/strict";
import { test } from "node:test";
import { HeroHand } from "../scripts/hand.js";

/** A small DOM boundary: these tests exercise the hand without a Foundry/browser runtime. */
function mountHand(t, { marginLeft = "0px" } = {}) {
  const events = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const frames = new Map();
  const attributes = new Map();
  const styles = new Map();
  const classes = new Set();
  const observers = [];
  const paintedHand = {};
  const status = { textContent: "" };
  const buttonEvents = new Map();
  let nextId = 1;
  let appended = 0;
  let removed = false;
  const button = {
    addEventListener: (type, callback) => buttonEvents.set(type, callback),
    setAttribute: (name, value) => attributes.set(name, value),
    contains: (target) => target === paintedHand,
    getBoundingClientRect: () => ({ height: 149 })
  };
  const element = {
    dataset: {},
    classList: {
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      add: (name) => classes.add(name),
      remove: (...names) => names.forEach(name => classes.delete(name))
    },
    style: { setProperty: (name, value) => styles.set(name, value) },
    querySelector: (selector) => selector === "button" ? button : status,
    contains: (target) => [button, status, paintedHand].includes(target),
    getBoundingClientRect: () => {
      const right = window.innerWidth - Number.parseFloat(element.style.right);
      return { left: right - Number.parseFloat(element.style.width), right };
    },
    remove: () => { removed = true; }
  };
  const sidebar = {
    getBoundingClientRect: () => ({ left: 940, width: 340, height: 800 })
  };
  const sidebarContent = {
    parentElement: sidebar,
    getBoundingClientRect: () => ({ left: 1000, width: 280, height: 800 })
  };
  class Observer {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() { this.disconnected = false; }
    disconnect() { this.disconnected = true; }
  }
  const globals = {
    document: {
      createElement: () => element,
      body: { append: () => { appended++; } },
      querySelector: selector => selector === "#sidebar-content" ? sidebarContent : sidebar
    },
    CSS: { supports: (_property, value) => /^#[a-f\d]{6}$/i.test(value) },
    MutationObserver: Observer,
    ResizeObserver: Observer,
    game: { user: { color: "#67a890" } },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      getComputedStyle: () => ({ marginLeft }),
      addEventListener: (type, callback) => events.set(type, callback),
      removeEventListener: (type, callback) => {
        if (events.get(type) === callback) events.delete(type);
      },
      setInterval: (callback) => { const id = nextId++; intervals.set(id, callback); return id; },
      clearInterval: (id) => intervals.delete(id),
      setTimeout: (callback) => { const id = nextId++; timeouts.set(id, callback); return id; },
      clearTimeout: (id) => timeouts.delete(id),
      requestAnimationFrame: (callback) => { const id = nextId++; frames.set(id, callback); return id; },
      cancelAnimationFrame: (id) => frames.delete(id)
    }
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const hand = new HeroHand().mount();
  t.after(() => {
    hand.destroy();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    hand, button, status, element, classes, attributes, styles, observers,
    events, intervals, timeouts, frames, paintedHand,
    get appended() { return appended; },
    get removed() { return removed; },
    click: () => buttonEvents.get("click")(),
    finishAnimation: () => {
      const [id, callback] = timeouts.entries().next().value;
      timeouts.delete(id);
      callback();
    },
    move: (overrides = {}) => events.get("pointermove")({
      clientX: 800, clientY: 200, pointerType: "mouse", target: {}, ...overrides
    })
  };
}

test("click plays locally with or without a coin and never changes gifting state", (t) => {
  const dom = mountHand(t);
  const initial = structuredClone(dom.hand.state);
  dom.click();
  assert.deepEqual(dom.hand.state, initial);
  assert.ok(dom.classes.has("is-playing-thumb"));
  assert.ok(!dom.attributes.has("aria-disabled"), "the hand remains an interactive toy without a coin");
  assert.match(dom.attributes.get("aria-label"), /Connecting to the GM/);
  assert.match(dom.attributes.get("aria-label"), /Click to wiggle/);

  dom.hand.setState({ available: true });
  assert.equal(dom.timeouts.size, 0, "a coin availability change stops the previous play animation");
  const ready = structuredClone(dom.hand.state);
  dom.click();
  assert.deepEqual(dom.hand.state, ready);
  assert.ok(dom.classes.has("is-playing-coin"));
  assert.ok(!dom.classes.has("is-playing-thumb"));
  assert.match(dom.attributes.get("aria-label"), /Click to play with your coin/);
  assert.match(dom.attributes.get("aria-label"), /press H to gift/);
  assert.equal(dom.status.textContent, "Click · Play / H · Gift");
  assert.ok(dom.classes.has("has-coin"));
  assert.equal(dom.styles.get("--hero-hand-color"), "#67a890");

  dom.hand.setState({ available: false, reason: "Waiting for the GM." });
  dom.click();
  assert.ok(dom.classes.has("is-playing-thumb"));
  assert.match(dom.attributes.get("aria-label"), /Waiting for the GM/);
  assert.ok(dom.classes.has("is-spent"));
  assert.ok(!dom.classes.has("has-coin"));
});

test("re-click restarts play, but a confirmed gift flick takes precedence", (t) => {
  const dom = mountHand(t);
  dom.hand.setState({ available: true });
  dom.click();
  const firstTimer = dom.timeouts.keys().next().value;
  dom.click();
  assert.equal(dom.timeouts.size, 1);
  assert.ok(!dom.timeouts.has(firstTimer));
  assert.ok(dom.classes.has("is-playing-coin"));

  dom.hand.flick();
  assert.ok(!dom.classes.has("is-playing-coin"));
  assert.ok(dom.classes.has("is-flicking"));
  const flickTimer = dom.timeouts.keys().next().value;
  dom.click();
  assert.ok(dom.classes.has("is-flicking"));
  assert.ok(!dom.classes.has("is-playing-coin"));
  assert.equal(dom.timeouts.keys().next().value, flickTimer);

  dom.finishAnimation();
  dom.click();
  assert.ok(!dom.classes.has("is-flicking"));
  assert.ok(dom.classes.has("is-playing-coin"));
});

test("cursor follows the viewport strip, clamps to screen, and leaves controls usable", (t) => {
  const dom = mountHand(t, { marginLeft: "-12px" });
  assert.equal(dom.element.style.right, "268px", "a negative content margin moves the arm's attachment farther right");
  dom.move();
  assert.equal(dom.styles.get("--hero-hand-y"), "200px");

  for (const event of [
    { clientX: 699, clientY: 300 },
    { clientX: 1013, clientY: 300 },
    { pointerType: "touch", clientY: 300 },
    { target: dom.paintedHand, clientY: 300 },
    { target: { closest: () => ({ tagName: "INPUT" }) }, clientY: 300 }
  ]) {
    dom.move(event);
    assert.equal(dom.styles.get("--hero-hand-y"), "200px");
  }

  dom.move({ clientY: -100 });
  assert.equal(dom.styles.get("--hero-hand-y"), "82.5px");
  dom.move({ clientY: 10000 });
  assert.equal(dom.styles.get("--hero-hand-y"), "701.5px");
});

test("countdown expiry does not independently authorize a gift", (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const dom = mountHand(t);
  dom.hand.setState({ available: false, cooldownUntil: now + 120_000, reason: "Party cooldown." });
  assert.equal(dom.status.textContent, "2:00 · Click to play");
  assert.match(dom.button.title, /Party cooldown.*2:00 remaining/);

  now += 120_001;
  for (const callback of dom.intervals.values()) callback();
  dom.click();
  assert.equal(dom.hand.state.available, false);
  assert.ok(dom.classes.has("is-playing-thumb"));
  assert.doesNotMatch(dom.button.title, /remaining/);
});

test("repeated flicks restart the animation without changing permission", (t) => {
  const dom = mountHand(t);
  dom.hand.flick();
  dom.hand.flick();
  assert.ok(dom.classes.has("is-flicking"));
  assert.equal(dom.timeouts.size, 1);
  assert.equal(dom.hand.state.available, false);
  dom.finishAnimation();
  assert.ok(!dom.classes.has("is-flicking"));
  dom.hand.flick();
  dom.hand.destroy();
  assert.equal(dom.timeouts.size, 0);
});

test("mount is idempotent and destroy releases listeners, observers, and scheduled work", (t) => {
  const dom = mountHand(t);
  assert.equal(dom.hand.mount(), dom.hand);
  assert.equal(dom.appended, 1);
  dom.events.get("resize")();
  dom.click();
  assert.equal(dom.frames.size, 1);
  assert.equal(dom.intervals.size, 1);
  assert.equal(dom.timeouts.size, 1);

  dom.hand.destroy();
  assert.equal(dom.events.size, 0);
  assert.equal(dom.intervals.size, 0);
  assert.equal(dom.timeouts.size, 0);
  assert.equal(dom.frames.size, 0);
  assert.ok(dom.observers.every((observer) => observer.disconnected));
  assert.equal(dom.hand.element, null);
  assert.ok(dom.removed);
  assert.doesNotThrow(() => dom.hand.flick());
  assert.doesNotThrow(() => dom.hand.play());
});
