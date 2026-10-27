import { MODULE_ID, COOLDOWN_MS, GiftError, emptyState, eligiblePlayers, normalizeState, recipientForToken } from "./rules.js";
import { GiftService } from "./service.js";
import { HeroHand } from "./hand.js";
import { registerCoinHooks, showGiftCoin } from "./coin.js";

let socket;
let service;
let hand;
let busy = false;
let refreshTimer;
let recoveryTimer;
const shownGifts = new Set();

registerCoinHooks();

function registerSocket() {
  if (socket || !globalThis.socketlib) return;
  socket = socketlib.registerModule(MODULE_ID);
  if (!socket) return;
  // A normal function preserves Socketlib's caller context. Player-supplied
  // arguments cannot opt into the GM exemption by claiming a different user ID.
  socket.register("gift", function(request) {
    return service?.handleRequest(request, this.socketdata?.userId)
      ?? { ok: false, error: "The GM is still connecting. Please try again shortly." };
  });
}

Hooks.once("socketlib.ready", registerSocket);

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "giftState", {
    scope: "world", config: false, type: Object, default: emptyState(),
    onChange: () => refreshHand()
  });
  game.settings.register(MODULE_ID, "showHand", {
    name: "Show the hero coin hand",
    hint: "Display your animated hand beside the sidebar. The gift keybinding works with the hand hidden.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => mountHand()
  });
  game.settings.register(MODULE_ID, "cooldownMinutes", {
    name: "Player gift cooldown (minutes)",
    hint: "Shared cooldown after a player gifts a Hero Point. Default: 60 minutes. Set 0 for no delay. Applies to future gifts; active countdowns keep their expiry. GM gifts never affect this timer.",
    scope: "world", config: true,
    type: new foundry.data.fields.NumberField({ nullable: false, integer: true, min: 0, initial: COOLDOWN_MS / 60000 }),
    default: COOLDOWN_MS / 60000
  });
  game.keybindings.register(MODULE_ID, "gift", {
    name: "Gift a Hero Point",
    hint: "Target exactly one other player's assigned character, then flick a coin their way.",
    editable: [{ key: "KeyH" }], restricted: false, precedence: 0,
    onDown: context => {
      const target = context?.event?.target ?? document.activeElement;
      if (context?.event?.repeat || target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return false;
      void gift();
      return true;
    }
  });
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") {
    ui.notifications.warn("Toss a Coin currently supports Pathfinder 2E worlds.");
    return;
  }
  registerSocket();
  service = new GiftService({
    game, resolveUuid: uuid => fromUuid(uuid),
    createMessage: data => foundry.documents.ChatMessage.create(data),
    notify: error => console.error(`${MODULE_ID} |`, error)
  });
  game.modules.get(MODULE_ID).api = Object.freeze({ gift, getState: () => structuredClone(service.state) });
  mountHand();
  refreshTimer = setInterval(refreshHand, 1000);
  recoveryTimer = setInterval(recover, 10000);
  recover();
});

function mountHand() {
  if (!game.ready || !service) return;
  hand?.destroy();
  hand = game.settings.get(MODULE_ID, "showHand") ? new HeroHand().mount() : null;
  refreshHand();
}

function refreshHand() {
  if (!service || !hand) return;
  const players = eligiblePlayers(game.users);
  const state = normalizeState(service.state, players);
  let reason = "";
  let cooldownUntil = 0;
  if (!socket) reason = "Enable Socketlib to gift Hero Points.";
  else if (!game.users.activeGM) reason = "A GM must be connected to gift Hero Points.";
  else if (state.pending) reason = "A coin is being processed…";
  else if (busy) reason = "Flicking your coin…";
  else if (!game.user.isGM) {
    if (!players.some(user => user.id === game.user.id)) reason = "Assign yourself a player character to gift a coin.";
    else if (state.cooldownUntil > Date.now()) {
      reason = "The party's next coin is on its way.";
      cooldownUntil = state.cooldownUntil;
    } else if (!players.some(user => user.id !== game.user.id && !state.received.includes(user.id))) {
      reason = "Waiting for another player to receive the next coin.";
    }
  }
  if (!reason && !players.some(user => {
    const resource = user.character?.system?.resources?.heroPoints;
    return user.id !== game.user.id && (game.user.isGM || !state.received.includes(user.id))
      && Number.isInteger(resource?.value) && Number.isInteger(resource?.max)
      && resource.max > 0 && resource.value < resource.max;
  })) reason = "No eligible character has room for another Hero Point.";
  hand.setState({ available: !reason, reason, cooldownUntil });
}

/** Public macro API as well as the gift keybinding action. */
async function gift() {
  if (busy) return { ok: false, error: "A gift is already in progress." };
  busy = true;
  refreshHand();
  try {
    if (!service || !socket) throw new GiftError("Toss a Coin requires an active Socketlib module and a PF2E world.");
    const gm = game.users.activeGM;
    if (!gm) throw new GiftError("A GM must be connected to gift a Hero Point.");
    const targets = Array.from(game.user.targets);
    if (targets.length !== 1) throw new GiftError("Target exactly one other player's character token first.");
    const token = targets[0].document;
    const recipient = recipientForToken(token, eligiblePlayers(game.users));
    if (recipient.id === game.user.id) throw new GiftError("You can only gift a Hero Point to another player.");
    const request = { version: 1, id: foundry.utils.randomID(24), tokenUuid: token.uuid };
    // Pick the same GM for every caller, including other GMs, to serialize awards.
    const result = await socket.executeAsUser("gift", gm.id, request);
    if (!result?.ok) throw new GiftError(result?.error || "The coin could not be gifted.");
    if (result.recovering) ui.notifications.info("Hero Point awarded. The coin announcement is recovering.");
    return result;
  } catch (error) {
    ui.notifications.warn(error.message);
    return { ok: false, error: error.message };
  } finally {
    busy = false;
    refreshHand();
  }
}

function recover() {
  if (service?.isAuthority && service.state.pending) {
    void service.recover().catch(error => console.error(`${MODULE_ID} | Recovery:`, error));
  }
}

// GM-created confirmations are the single source of animation on every client.
Hooks.on("createChatMessage", (message, _options, userId) => {
  const receipt = message.getFlag(MODULE_ID, "receipt");
  if (!game.users.get(userId)?.isGM || !receipt?.id || shownGifts.has(receipt.id)) return;
  shownGifts.add(receipt.id);
  if (shownGifts.size > 256) shownGifts.delete(shownGifts.values().next().value);
  if (receipt.donorId === game.user.id) hand?.flick();
  void showGiftCoin(receipt);
  refreshHand();
});

for (const event of ["userConnected", "updateUser", "createUser", "deleteUser", "updateActor"]) {
  Hooks.on(event, () => { refreshHand(); });
}

globalThis.addEventListener?.("pagehide", () => {
  hand?.destroy();
  clearInterval(refreshTimer);
  clearInterval(recoveryTimer);
}, { once: true });
