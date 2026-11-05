import { HeroHand } from "./hand.js";

const MOVE_INTERVAL = 50;
const HEARTBEAT_INTERVAL = 5000;

/** Ephemeral hand presence; it never awards points or accepts gift commands. */
export class HandPresence {
  constructor({ game, send, stateFor, isVisible, createHand = options => new HeroHand(options),
    session = globalThis.crypto.randomUUID(), now = () => globalThis.performance.now(),
    schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
    cancel = timer => globalThis.clearTimeout(timer) }) {
    Object.assign(this, { game, send, stateFor, isVisible, createHand, session, now, schedule, cancel });
    this.hands = new Map();
    this.peers = new Map();
    this.sequence = 0;
    this.position = null;
    this.moveTimer = null;
    this.lastMove = -Infinity;
    this.lastHeartbeat = -Infinity;
    this.started = false;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.visible = Boolean(this.isVisible());
    this.lastHeartbeat = this.now();
    this.refresh();
    this.announce();
    return this;
  }

  initialPosition(userId) {
    const users = Array.from(this.game.users).filter(user => user.active && !user.isBanned)
      .sort((a, b) => a.id.localeCompare(b.id));
    const index = Math.max(0, users.findIndex(user => user.id === userId));
    return (index + 1) / (users.length + 1);
  }

  refresh() {
    if (!this.started) return;
    const visible = Boolean(this.isVisible());
    const changed = this.visible !== visible;
    this.visible = visible;
    const active = new Set();
    for (const user of this.game.users) {
      if (!user.active || user.isBanned) continue;
      active.add(user.id);
      this.syncHand(user);
    }
    for (const [id, hand] of this.hands) {
      if (!active.has(id)) {
        hand.destroy();
        this.hands.delete(id);
      }
    }
    for (const id of this.peers.keys()) if (!active.has(id)) this.peers.delete(id);
    if (changed) {
      this.cancel(this.moveTimer);
      this.moveTimer = null;
      this.emit("state");
    }
    if (this.now() - this.lastHeartbeat >= HEARTBEAT_INTERVAL) {
      this.emit("state");
      this.lastHeartbeat = this.now();
    }
  }

  syncHand(user) {
    const local = user.id === this.game.user.id;
    const peer = this.peers.get(user.id);
    let hand = this.hands.get(user.id);
    if (!this.visible || (!local && peer?.visible === false)) {
      if (hand) {
        if (local) this.position = hand.getPosition();
        hand.destroy();
        this.hands.delete(user.id);
      }
      return;
    }
    if (!hand) {
      hand = this.createHand({
        user, interactive: local,
        initialPosition: local ? this.position ?? this.initialPosition(user.id) : peer?.y ?? this.initialPosition(user.id),
        onMove: local ? y => this.move(y) : undefined,
        onPlay: local ? () => this.emit("play") : undefined
      }).mount();
      this.hands.set(user.id, hand);
    }
    hand.setState(this.stateFor(user));
  }

  move(y) {
    if (!this.started || !this.visible || !Number.isFinite(y)) return;
    this.position = Math.max(0, Math.min(1, y));
    if (this.moveTimer !== null) return;
    const elapsed = this.now() - this.lastMove;
    if (elapsed >= MOVE_INTERVAL) this.flushMove();
    else this.moveTimer = this.schedule(() => this.flushMove(), MOVE_INTERVAL - elapsed);
  }

  flushMove() {
    this.cancel(this.moveTimer);
    this.moveTimer = null;
    if (!this.started || !this.visible) return;
    this.lastMove = this.now();
    this.emit("move");
  }

  emit(type, recipientId) {
    if (!this.started) return;
    const y = this.position ?? this.hands.get(this.game.user.id)?.getPosition() ?? this.initialPosition(this.game.user.id);
    const packet = { version: 1, type, session: this.session, sequence: ++this.sequence, y, visible: this.visible };
    // Presence traffic uses Socketlib commands rather than awaiting every client.
    try { Promise.resolve(this.send(packet, recipientId)).catch(() => {}); }
    catch { /* A reconnect/next heartbeat will restore presence. */ }
  }

  announce() {
    this.emit("hello");
    this.lastHeartbeat = this.now();
  }

  receive(userId, packet) {
    if (!this.started || userId === this.game.user.id) return false;
    const user = this.game.users.get(userId);
    if (!user?.active || user.isBanned || !packet || packet.version !== 1
      || !["hello", "state", "move", "play"].includes(packet.type)
      || typeof packet.session !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(packet.session)
      || !Number.isSafeInteger(packet.sequence) || packet.sequence < 1
      || !Number.isFinite(packet.y) || packet.y < 0 || packet.y > 1
      || typeof packet.visible !== "boolean") return false;
    const previous = this.peers.get(userId);
    const retired = previous?.retired ?? new Set();
    if (retired.has(packet.session)) return false;
    if (previous?.session === packet.session && previous.sequence >= packet.sequence) return false;
    if (previous && previous.session !== packet.session) {
      retired.add(previous.session);
      if (retired.size > 8) retired.delete(retired.values().next().value);
    }
    this.peers.set(userId, { session: packet.session, sequence: packet.sequence,
      y: packet.y, visible: packet.visible, retired });
    this.syncHand(user);
    const hand = this.hands.get(userId);
    hand?.setPosition(packet.y);
    if (packet.type === "play") hand?.play();
    // New clients learn the current position without waiting for another move.
    if (packet.type === "hello") this.emit("state", userId);
    return true;
  }

  flick(userId) {
    if (!this.started) return;
    this.refresh();
    this.hands.get(userId)?.flick();
  }

  destroy() {
    if (!this.started) return;
    this.visible = false;
    this.emit("state");
    this.started = false;
    this.cancel(this.moveTimer);
    this.moveTimer = null;
    for (const hand of this.hands.values()) hand.destroy();
    this.hands.clear();
    this.peers.clear();
  }
}
