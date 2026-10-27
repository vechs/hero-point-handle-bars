# Toss a Coin to Your Witcher

A Foundry VTT v14 module for Pathfinder 2E. Target another player's character, press **H**, and flick a Hero Point their way with a spindly, player-colored cartoon hand. If Dice So Nice is enabled, the flying coin uses the recipient's token image on both faces.

## Install

1. Place this directory at `<Foundry user data>/Data/modules/hero-point-handle-bars`. `module.json` must be directly inside that directory.
2. Install and enable [Socketlib](https://foundryvtt.com/packages/socketlib). It is required. Enable [Dice So Nice](https://foundryvtt.com/packages/dice-so-nice) for the portrait coin animation.
3. Restart Foundry after adding the module, then enable **Toss a Coin to Your Witcher** in your PF2E world's Manage Modules window.
4. Assign each player their character in Foundry's user configuration. Their scene token must have **Link Actor Data** enabled.
5. Keep at least one GM connected. Socketlib executes gifts automatically in that GM's context; there are no GM approval dialogs.

This is an initial source release. There is no hosted installation manifest or automatic update endpoint yet.

The root `module.json` includes the known module metadata and dependency declarations. Replace `TODO: Author name` and the `example.invalid` URLs for the project, latest manifest, versioned ZIP download, and issue tracker before publishing. The ZIP filename in `download` matches the packaging command's output. No software license has been chosen yet.

## Play

Use Foundry's targeting tool to target exactly one other player's character token. Press **H** or click your hand to gift them one Hero Point. Remap the shortcut in **Configure Controls → Toss a Coin to Your Witcher** if it conflicts with another binding.

Your arm attaches to the left edge of Foundry's sidebar content panel, behind the tab rail, with a slightly translucent sleeve. Move your cursor vertically in the strip occupied by the hand and arm to move it. The hand rolls its coin and twiddles its thumb while a gift is available. After a gift, it gives a thumbs up and displays the remaining cooldown. It follows your Foundry player color and respects reduced motion preferences.

The client setting **Show the hero coin hand** hides the overlay while keeping the keybinding available. Input fields do not trigger the shortcut. The empty overlay and arm let canvas clicks pass through.

## Gift rules

- Every successful player gift starts a **shared, real-time 60-minute cooldown** for all players, including its giver. It continues while Foundry is paused or players are offline.
- A recipient can receive one player-gifted coin per round. The round restarts as soon as every eligible player has received one; finishing a round does not remove the cooldown.
- Eligible players are non-GM, non-banned users with assigned PF2E character actors. Offline players remain in the rotation. Accounts without assigned characters are excluded. Removed accounts are dropped from the rotation; newly assigned players join it.
- You cannot gift yourself. Only tokens linked to exactly one eligible user's assigned character can receive coins. Ambiguous assignments, NPCs, and unlinked tokens are rejected.
- A gift creates one Hero Point for the recipient. It does **not** subtract a Hero Point from the giver's character. The hand's coin is the gifting resource.
- PF2E's actual Hero Point maximum is respected. A capped character cannot consume a gift or advance the rotation. Characters whose Hero Point maximum is zero, such as mythic characters using a different resource, cannot receive these coins.
- GMs and assistant GMs are excluded as recipients. Their gifts bypass the cooldown and recipient rotation and change neither. Resource caps still apply.

The global cooldown and inclusion of offline assigned characters are deliberate interpretations of the repository's rules.

## How it works

Socketlib sends every gift to `game.users.activeGM`, including gifts initiated by other GMs. One queue validates and processes those requests so simultaneous player gifts cannot both spend the same available coin. The donor is identified from Socketlib's caller context rather than a user ID supplied in the request.

A hidden world setting stores the cooldown, recipient round, and an in-progress journal. The Hero Point and the request's retry marker are written together to the character. A GM-created chat announcement confirms the gift and triggers each client's local Dice So Nice animation once. Cosmetic animation failures do not undo awarded points.

Foundry modules run in browser clients rather than as persistent server workers. Saving the small state in the world protects it across browser refreshes and GM handoffs. If a GM disappears mid-gift, the active GM checks the journal after 30 seconds, completing an applied award's announcement or releasing an unapplied reservation. Requests interrupted before reaching the GM can be retried manually. This is recovery across Foundry document operations, not a database transaction spanning multiple documents.

Dice So Nice is optional. Token art is fitted to a circular 256px PNG face, including SVG source art. Each client caches and reuses portrait presets; registration is capped at 128 distinct portraits per tab because DSN has no public removal API. Reloading clears that cache. Portraits must be loadable by the browser; cross-origin art needs CORS support. Gifts still work when DSN is absent, disabled, or cannot load an image.

## Development and verification

Foundry loads the ES modules and CSS directly; there are no runtime npm dependencies or bundling requirements. With Node.js 22 or newer, install the locked development tools and run the checks:

```sh
npm ci
npm run check
npm test
```

The tests cover cooldown boundaries, recipient rotation, GM exemptions, resource caps, simultaneous gifts, duplicate requests, failed writes, recovery, hand lifecycle, and Dice So Nice integration with mocks. A licensed Foundry runtime is not bundled; actual Foundry rendering and multiplayer behavior still require the checks below.

### Packaging and CLI

```sh
npm run package
```

This runs the checks and tests, then writes a reproducible ZIP to `dist/hero-point-handle-bars-<version>.zip`, a copy of `module.json`, and `SHA256SUMS`. The ZIP has `module.json` at its root and contains the runtime JavaScript, CSS, and README. Extract it into the module directory described above. Development dependencies, test files, the preview, and Node-only tooling are excluded.

The official [Foundry VTT CLI](https://github.com/foundryvtt/foundryvtt-cli) is pinned as a development dependency in `package-lock.json`. Run it locally with `npm run fvtt -- --help`. Its `package pack` command compiles compendium databases; this module currently has no compendiums, so release ZIP creation uses the separately pinned `fflate` library. No Foundry installation or CLI configuration is required to build the ZIP.

For a standalone visual preview, run `python3 -m http.server 8000` from this directory and open `http://localhost:8000/dev/hand-preview.html`. It exercises the real hand and CSS with a mock sidebar; it does not award points.

### Foundry smoke test

1. Open one GM and at least three player sessions. Give each player a different assigned, linked character token and at least one spare Hero Point slot.
2. Target another player's token and press H. Confirm exactly one point is added, one public chat announcement appears, the giver flicks, and each DSN-enabled client sees one coin with the target's artwork.
3. Confirm all player hands show a cooldown and further player gifts fail. A GM should still be able to gift repeatedly, subject to the resource cap, without changing the saved cooldown or round.
4. In a disposable test world, shorten the cooldown between gifts using the GM console below. Verify a previous recipient remains blocked until all eligible players receive a coin, including players who log out.
5. Try self-targeting, no target, multiple targets, an NPC, an unlinked token, duplicate character assignments, a capped character, and pressing H while typing in chat. None should award a point.
6. Refresh the GM and player browsers and switch the active GM. Verify the cooldown and rotation remain. Exercise simultaneous player gifts and a GM disconnect during an award.
7. Try a WebP, PNG, and SVG token portrait; disable DSN and repeat. Check sidebar collapse, viewport resize, player color changes, reduced motion, and clicking the canvas underneath the arm.

GM console, **test worlds only**, to expire just the cooldown while preserving the rotation:

```js
const moduleId = "hero-point-handle-bars";
const state = structuredClone(game.settings.get(moduleId, "giftState"));
if (state.pending) throw new Error("Wait for the pending coin to finish first.");
await game.settings.set(moduleId, "giftState", { ...state, cooldownUntil: 0 });
```

Macro API:

```js
await game.modules.get("hero-point-handle-bars").api.gift();
game.modules.get("hero-point-handle-bars").api.getState();
```

## API references

- [Foundry v14 public API](https://foundryvtt.com/api/v14/)
- [Socketlib registration and remote execution](https://github.com/farling42/foundryvtt-socketlib)
- [Dice So Nice customization](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/customization/), [dice systems](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/dice-systems/), and [roll display](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/roll/)
- [PF2E character resource implementation](https://github.com/foundryvtt/pf2e/blob/v14-dev/src/module/actor/character/document.ts)
