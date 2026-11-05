import test from "node:test";
import assert from "node:assert/strict";
import { HandPresence } from "../scripts/presence.js";

function fixture(viewerId = "alice") {
  const users = ["alice", "bob", "gm"].map(id => ({ id, name: id, active: true, isGM: id === "gm" }));
  users.get = id => users.find(user => user.id === id);
  const game = { user: users.get(viewerId), users };
  let enabled = true;
  let now = 0;
  let id = 0;
  const pending = new Map();
  const sent = [];
  const created = [];
  const presence = new HandPresence({
    game, session: "local-session", now: () => now,
    isVisible: () => enabled,
    stateFor: user => ({ available: user.isGM, cooldownUntil: user.isGM ? 0 : 1000 }),
    send: (packet, recipientId) => sent.push({ packet, recipientId }),
    schedule: (callback, delay) => { const key = ++id; pending.set(key, { callback, at: now + delay }); return key; },
    cancel: key => pending.delete(key),
    createHand: options => {
      const hand = {
        options, y: options.initialPosition, playCount: 0, flickCount: 0, destroyed: false,
        mount() { return this; },
        setState(state) { this.state = state; },
        setPosition(y) { this.y = y; }, getPosition() { return this.y; },
        play() { this.playCount++; }, flick() { this.flickCount++; },
        destroy() { this.destroyed = true; }
      };
      created.push(hand);
      return hand;
    }
  }).start();
  const packet = (overrides = {}) => ({ version: 1, type: "state", session: "bob-session",
    sequence: 1, y: 0.3, visible: true, ...overrides });
  function advance(ms) {
    now += ms;
    for (const [key, timer] of [...pending]) {
      if (timer.at <= now) { pending.delete(key); timer.callback(); }
    }
  }
  return { presence, game, users, sent, pending, created, packet, advance,
    setEnabled: value => { enabled = value; } };
}

test("connected owners each get a local renderer with only the viewer's hand interactive", () => {
  const f = fixture();
  assert.equal(f.presence.hands.size, 3);
  assert.equal(f.presence.hands.get("alice").options.interactive, true);
  assert.equal(f.presence.hands.get("bob").options.interactive, false);
  assert.equal(f.presence.hands.get("gm").state.available, true);
  assert.equal(f.presence.hands.get("bob").state.available, false);
  assert.equal(new Set(f.created.map(hand => hand.y)).size, 3, "initial hands should not all overlap");
  assert.equal(f.sent[0].packet.type, "hello");
  f.presence.destroy();
});

test("movement is bounded to 20 updates per second and flushes the final position", () => {
  const f = fixture();
  f.sent.length = 0;
  const local = f.presence.hands.get("alice");
  local.options.onMove(0.2);
  local.options.onMove(0.4);
  local.options.onMove(0.7);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].packet.y, 0.2);
  assert.equal(f.pending.size, 1);
  f.advance(49);
  assert.equal(f.sent.length, 1);
  f.advance(1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].packet.y, 0.7);
  assert.equal(f.sent[1].packet.type, "move");
  assert.equal(f.pending.size, 0);
  f.presence.destroy();
});

test("authenticated sender identity routes remote movement and clicks without a rebroadcast loop", () => {
  const f = fixture();
  f.sent.length = 0;
  assert.equal(f.presence.receive("bob", f.packet({ type: "play", userId: "alice", y: 0.8 })), true);
  assert.equal(f.presence.hands.get("bob").y, 0.8);
  assert.equal(f.presence.hands.get("bob").playCount, 1);
  assert.equal(f.presence.hands.get("alice").playCount, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.presence.receive("bob", f.packet({ type: "play", y: 0.8 })), false);
  assert.equal(f.presence.hands.get("bob").playCount, 1, "duplicate clicks must not replay");
  f.presence.destroy();
});

test("late join handshake sends the latest position directly to the joining user", () => {
  const f = fixture();
  f.presence.hands.get("alice").options.onMove(0.9);
  f.sent.length = 0;
  f.presence.receive("bob", f.packet({ type: "hello" }));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].recipientId, "bob");
  assert.equal(f.sent[0].packet.type, "state");
  assert.equal(f.sent[0].packet.y, 0.9);
  f.advance(5000);
  f.presence.refresh();
  assert.equal(f.sent.at(-1).packet.type, "state");
  assert.equal(f.sent.at(-1).recipientId, undefined);
  f.presence.announce();
  assert.equal(f.sent.at(-1).packet.type, "hello", "reconnections can repeat discovery");
  f.presence.destroy();
});

test("invalid, disconnected, self, forged gift, and stale-session packets are ignored", () => {
  const f = fixture();
  for (const [sender, overrides] of [
    ["unknown", {}], ["alice", {}], ["bob", { y: Infinity }], ["bob", { y: -0.1 }],
    ["bob", { y: 1.1 }], ["bob", { type: "flick" }], ["bob", { sequence: 0 }],
    ["bob", { sequence: 1.5 }], ["bob", { visible: "yes" }], ["bob", { session: "" }]
  ]) assert.equal(f.presence.receive(sender, f.packet(overrides)), false);
  assert.equal(f.presence.receive("bob", f.packet({ sequence: 4 })), true);
  assert.equal(f.presence.receive("bob", f.packet({ sequence: 2 })), false);
  assert.equal(f.presence.receive("bob", f.packet({ session: "new-tab", sequence: 1 })), true);
  assert.equal(f.presence.receive("bob", f.packet({ sequence: 5 })), false);
  f.users.get("bob").active = false;
  assert.equal(f.presence.receive("bob", f.packet({ session: "new-tab", sequence: 2 })), false);
  f.presence.destroy();
});

test("confirmed gifts animate the matching owner's hand on every viewer, including the GM", () => {
  const f = fixture();
  f.presence.flick("bob");
  f.presence.flick("gm");
  assert.equal(f.presence.hands.get("bob").flickCount, 1);
  assert.equal(f.presence.hands.get("gm").flickCount, 1);
  assert.equal(f.presence.hands.get("alice").flickCount, 0);
  f.presence.destroy();
});

test("hide, disconnect, rejoin and teardown remove hands and pending movement timers", () => {
  const f = fixture();
  const oldBob = f.presence.hands.get("bob");
  f.presence.receive("bob", f.packet({ visible: false }));
  assert.equal(oldBob.destroyed, true);
  assert.equal(f.presence.hands.has("bob"), false);
  f.presence.receive("bob", f.packet({ sequence: 2, y: 0.6 }));
  const rejoinedBob = f.presence.hands.get("bob");
  assert.equal(rejoinedBob.y, 0.6);
  f.users.get("bob").active = false;
  f.presence.refresh();
  assert.equal(rejoinedBob.destroyed, true);
  assert.equal(f.presence.peers.has("bob"), false);

  f.presence.hands.get("alice").options.onMove(0.4);
  f.presence.hands.get("alice").options.onMove(0.5);
  assert.equal(f.pending.size, 1);
  f.setEnabled(false);
  f.presence.refresh();
  assert.equal(f.presence.hands.size, 0);
  assert.equal(f.pending.size, 0);
  assert.equal(f.sent.at(-1).packet.visible, false);
  f.setEnabled(true);
  f.presence.refresh();
  assert.equal(f.presence.hands.size, 2);
  f.presence.destroy();
  assert.equal(f.presence.hands.size, 0);
  assert.equal(f.presence.peers.size, 0);
  assert.equal(f.pending.size, 0);
  assert.equal(f.sent.at(-1).packet.visible, false);
});

test("a GM and a player exchange discovery, movement and clicks in both directions", () => {
  const player = fixture("alice");
  const gm = fixture("gm");
  const clients = [player, gm];
  const queue = [];
  for (const client of clients) {
    client.users.get("bob").active = false;
    client.presence.refresh();
    client.presence.send = (packet, recipientId) => queue.push({ senderId: client.game.user.id, packet, recipientId });
  }
  function deliver() {
    let count = 0;
    while (queue.length) {
      assert.ok(++count < 50, "discovery replies must not form a network loop");
      const { senderId, packet, recipientId } = queue.shift();
      for (const client of clients) {
        if (client.game.user.id !== senderId && (!recipientId || recipientId === client.game.user.id)) {
          client.presence.receive(senderId, structuredClone(packet));
        }
      }
    }
  }
  player.presence.announce();
  gm.presence.announce();
  deliver();
  assert.equal(player.presence.hands.size, 2);
  assert.equal(gm.presence.hands.size, 2);
  assert.equal(player.presence.hands.get("gm").options.interactive, false);
  assert.equal(gm.presence.hands.get("alice").options.interactive, false);
  player.presence.hands.get("alice").options.onMove(0.78);
  gm.presence.hands.get("gm").options.onMove(0.23);
  deliver();
  assert.equal(gm.presence.hands.get("alice").y, 0.78);
  assert.equal(player.presence.hands.get("gm").y, 0.23);
  player.presence.hands.get("alice").options.onPlay();
  gm.presence.hands.get("gm").options.onPlay();
  deliver();
  assert.equal(gm.presence.hands.get("alice").playCount, 1);
  assert.equal(player.presence.hands.get("gm").playCount, 1);
  for (const client of clients) client.presence.destroy();
});
