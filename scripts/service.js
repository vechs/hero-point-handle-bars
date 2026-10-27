import { MODULE_ID, HERO_POINT_PATH, GiftError, eligiblePlayers, normalizeState,
  recipientForToken, planGift, escapeHTML } from "./rules.js";

/** One active GM serializes all gifts, including requests from other GMs. */
export class GiftService {
  #queue = Promise.resolve();
  #requests = new Map();

  constructor({ game, resolveUuid, createMessage, now = Date.now, notify = console.error }) {
    Object.assign(this, { game, resolveUuid, createMessage, now, notify });
  }

  get isAuthority() {
    return this.game.user.isGM && this.game.users.activeGM?.id === this.game.user.id;
  }

  get state() {
    return normalizeState(this.game.settings.get(MODULE_ID, "giftState"), eligiblePlayers(this.game.users));
  }

  #enqueue(task) {
    const result = this.#queue.then(task);
    this.#queue = result.catch(error => this.notify(error));
    return result;
  }

  /** creatorId comes from Socketlib's server-attributed socketdata, never a payload field. */
  handleRequest(request, creatorId) {
    if (!this.isAuthority) return Promise.resolve({ ok: false, error: "The active GM changed. Please try again." });
    if (!request || typeof request.id !== "string" || !/^[a-zA-Z0-9_-]{16,64}$/.test(request.id)) {
      return Promise.resolve({ ok: false, error: "Invalid coin request." });
    }
    const existing = this.#requests.get(request.id);
    if (existing) {
      return existing.creatorId === creatorId ? existing.result
        : Promise.resolve({ ok: false, error: "That coin request belongs to another user." });
    }
    const result = this.#enqueue(() => this.#process(request, creatorId));
    this.#requests.set(request.id, { creatorId, result });
    // Retain recent completed requests to make accidental retries idempotent.
    void result.finally(() => {
      if (this.#requests.size > 1000) this.#requests.delete(this.#requests.keys().next().value);
    }).catch(() => {});
    return result;
  }

  recover() {
    return this.#enqueue(() => this.#recover());
  }

  async #save(state) {
    if (!this.isAuthority) throw new GiftError("The active GM changed. Please try again.");
    await this.game.settings.set(MODULE_ID, "giftState", state);
  }

  async #recover() {
    if (!this.isAuthority) return;
    const pending = this.state.pending;
    if (!pending) return;
    // Allow a disconnected GM's last server operation time to settle first.
    if (this.now() - pending.startedAt < 30000) return;
    const actor = await this.resolveUuid(pending.actorUuid);
    if (!actor) throw new GiftError("Cannot recover the pending coin: its character was removed. Inspect the saved giftState before resetting it.");
    const committed = actor.getFlag(MODULE_ID, "lastGift")?.id === pending.id;
    if (committed) {
      await this.#publish(pending.receipt);
      await this.#save({ ...this.state, pending: null });
    } else {
      await this.#save(pending.previousState);
    }
  }

  async #process(request, creatorId) {
    let reservation;
    let committed = false;
    let writeAttempted = false;
    let writeCancelled = false;
    try {
      if (!this.isAuthority) throw new GiftError("The active GM changed. Please try again.");
      if (this.game.system.id !== "pf2e") throw new GiftError("Hero Point gifting currently supports Pathfinder 2E.");
      const donor = this.game.users.get(creatorId);
      if (!donor) throw new GiftError("The gifting user could not be identified.");
      if (request.version !== 1 || typeof request.tokenUuid !== "string"
        || !/^Scene\.[^.]+\.Token\.[^.]+$/.test(request.tokenUuid)) {
        throw new GiftError("The coin request contains an invalid token.");
      }
      const token = await this.resolveUuid(request.tokenUuid);
      if (token?.parent?.id !== donor.viewedScene) throw new GiftError("Target a token in the scene you are viewing.");
      const players = eligiblePlayers(this.game.users);
      const recipient = recipientForToken(token, players);
      const actor = token.actor;
      const last = actor.getFlag(MODULE_ID, "lastGift");
      if (last?.id === request.id && last.receipt?.donorId === creatorId) {
        return { ok: true, receipt: last.receipt };
      }
      const previousState = this.state;
      const plan = planGift({ state: previousState, donor, recipient, actor, players, now: this.now() });
      const receipt = {
        id: request.id, donorId: donor.id, donorName: donor.name,
        recipientId: recipient.id, recipientName: recipient.name,
        tokenImage: token.texture?.src || actor.img,
        heroPoints: plan.after, gmGift: Boolean(donor.isGM)
      };
      reservation = {
        ...plan.nextState,
        pending: { id: request.id, actorUuid: actor.uuid, startedAt: this.now(), previousState, receipt }
      };
      // Journal first; the award and its retry marker share one Actor update.
      await this.#save(reservation);
      if (!this.isAuthority) throw new GiftError("The active GM changed while processing the coin.");
      writeAttempted = true;
      const updated = await actor.update({
        [HERO_POINT_PATH]: plan.after,
        [`flags.${MODULE_ID}.lastGift`]: { id: request.id, receipt }
      });
      writeCancelled = !updated;
      if (!updated || actor.system.resources.heroPoints.value !== plan.after
        || actor.getFlag(MODULE_ID, "lastGift")?.id !== request.id) {
        throw new Error("The character update did not apply the Hero Point award.");
      }
      committed = true;
      await this.#publish(receipt);
      await this.#save({ ...plan.nextState, pending: null });
      return { ok: true, receipt };
    } catch (error) {
      if (committed) {
        // Keep the journal: never reject an applied award or release its lock.
        this.notify(new Error(`Coin awarded; confirmation will recover shortly: ${error.message}`));
        return { ok: true, receipt: reservation.pending.receipt, recovering: true };
      }
      if (reservation && this.isAuthority) {
        const actor = await this.resolveUuid(reservation.pending.actorUuid);
        if (actor?.getFlag(MODULE_ID, "lastGift")?.id === request.id) {
          return { ok: true, receipt: reservation.pending.receipt, recovering: true };
        }
        if (writeAttempted && !writeCancelled) {
          // A missing acknowledgement does not prove the server rejected the
          // update. Keep the journal until delayed recovery checks the marker.
          this.notify(error);
          return { ok: false, error: "The coin request was interrupted. Its outcome will be checked shortly; wait before trying again." };
        }
        await this.#save(reservation.pending.previousState);
      }
      if (!(error instanceof GiftError)) this.notify(error);
      return { ok: false, error: error.message };
    }
  }

  async #publish(receipt) {
    if (!this.isAuthority) throw new GiftError("The active GM changed before the coin announcement.");
    if (Array.from(this.game.messages).some(message => message.getFlag(MODULE_ID, "receipt")?.id === receipt.id)) return;
    const message = await this.createMessage({
      content: `<p><strong>${escapeHTML(receipt.donorName)}</strong> flicks a coin to <strong>${escapeHTML(receipt.recipientName)}</strong> — +1 Hero Point!</p>`,
      flags: { [MODULE_ID]: { receipt } }
    });
    if (!message || message.getFlag(MODULE_ID, "receipt")?.id !== receipt.id) {
      throw new Error("The coin announcement was cancelled or did not retain its confirmation.");
    }
  }
}
