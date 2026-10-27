/**
 * Optional Dice So Nice portrait coins. All calls are local: the gift controller
 * broadcasts the successful gift and each client renders its own portrait.
 *
 * Public API references:
 * https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/customization/
 * https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/roll/
 */
const MODULE_ID = "hero-point-handle-bars";
const MAX_PORTRAITS = 128;
const MAX_SEEN_GIFTS = 256;
const portraits = new Map();
const seenGifts = new Set();
const objectURLs = new Set();
let dice3d;
let registered = false;
let portraitSequence = 0;
let warnedAboutLimit = false;

/** Register this before Foundry's ready hook; safe when Dice So Nice is absent. */
export function registerCoinHooks() {
  if (registered) return;
  registered = true;
  Hooks.once("diceSoNiceReady", (api) => {
    dice3d = api;
  });
  // Blob URLs remain valid for DSN's lazy texture loads until the tab closes.
  globalThis.addEventListener?.("pagehide", () => {
    for (const url of objectURLs) URL.revokeObjectURL(url);
    objectURLs.clear();
  }, { once: true });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => {
      image.onload = image.onerror = null;
      image.src = "";
      reject(new Error("The token portrait took too long to load."));
    }, 10000);
    image.crossOrigin = "anonymous";
    image.onload = () => {
      clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("The token portrait could not be loaded."));
    };
    image.src = src;
  });
}

/** Normalize arbitrary token sizes (including SVG) into DSN's 256px faces. */
async function createPortraitURL(src) {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A canvas is required to draw a portrait coin.");
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("The token portrait has no dimensions.");

  // Fit the full token inside a circular coin face without stretching it.
  context.fillStyle = "#d9ac45";
  context.beginPath();
  context.arc(128, 128, 125, 0, Math.PI * 2);
  context.fill();
  context.save();
  context.beginPath();
  context.arc(128, 128, 114, 0, Math.PI * 2);
  context.clip();
  const scale = Math.min(224 / width, 224 / height);
  context.drawImage(image, (256 - width * scale) / 2, (256 - height * scale) / 2,
    width * scale, height * scale);
  context.restore();
  context.strokeStyle = "#78501c";
  context.lineWidth = 5;
  context.beginPath();
  context.arc(128, 128, 121, 0, Math.PI * 2);
  context.stroke();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not create a portrait coin.")), "image/png");
  });
  const url = URL.createObjectURL(blob);
  objectURLs.add(url);
  // DSN detects images by their filename extension. A fragment preserves the
  // local blob resource while satisfying that extension check.
  return `${url}#.png`;
}

async function registerPortrait(api, tokenImage, recipientName) {
  if (portraits.has(tokenImage)) return portraits.get(tokenImage);
  // DSN has no public preset-removal API. Reuse portraits across gifts and cap
  // registration instead of accumulating a new system with every flick.
  if (portraits.size >= MAX_PORTRAITS) {
    if (!warnedAboutLimit) {
      console.warn(`${MODULE_ID} | Portrait coin limit reached; reload this tab to load new portraits.`);
      warnedAboutLimit = true;
    }
    return null;
  }
  const pending = (async () => {
    const label = await createPortraitURL(tokenImage);
    const system = `${MODULE_ID}-portrait-${++portraitSequence}`;
    // The object form is part of DSN's public backwards-compatible addSystem API.
    api.addSystem({ id: system, name: `Hero Coin: ${recipientName}`, group: "Hero Coins" }, "default");
    api.addDicePreset({ type: "d2", labels: [label, label], system }, "d2");
    if (typeof api.preloadPresets === "function") await api.preloadPresets(system);
    return system;
  })();
  portraits.set(tokenImage, pending);
  try {
    return await pending;
  } catch (error) {
    portraits.delete(tokenImage);
    throw error;
  }
}

/**
 * Show one successful gift on this client; never updates Hero Points or chat.
 * Returns false when DSN is absent, disabled, or the artwork cannot be loaded.
 * @param {{id: string, recipientName: string, tokenImage: string}} gift
 * @returns {Promise<boolean>}
 */
export async function showGiftCoin({ id, recipientName = "Hero", tokenImage } = {}) {
  const api = dice3d;
  if (!api || typeof api.show !== "function" || !tokenImage) return false;
  if (id && seenGifts.has(id)) return false;
  if (id) {
    seenGifts.add(id);
    if (seenGifts.size > MAX_SEEN_GIFTS) seenGifts.delete(seenGifts.values().next().value);
  }
  try {
    const system = await registerPortrait(api, tokenImage, recipientName);
    if (!system) return false;
    const data = {
      throws: [{ dice: [{
        type: "d2", result: 1, resultLabel: recipientName, vectors: [],
        options: { appearance: {
          system, colorset: "custom", foreground: "#ffffff", background: "#d9ac45",
          outline: "none", edge: "#9d702b", texture: "none", material: "metal"
        } }
      }] }]
    };
    return Boolean(await api.show(data, game.user, false));
  } catch (error) {
    // A cosmetic failure must never turn an already-awarded point into a failed gift.
    console.warn(`${MODULE_ID} | Could not animate the portrait coin.`, error);
    return false;
  }
}
