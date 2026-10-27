const SVG = `
<svg class="hero-hand__drawing" viewBox="0 0 320 170" aria-hidden="true" focusable="false">
  <g class="hero-hand__gesture" stroke="#241c27" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <path class="hero-hand__arm" d="M320 93 C258 96 185 91 120 91 L102 120 C177 112 245 118 320 114 Z"/>
    <path class="hero-hand__arm-highlight" d="M143 96 C211 100 266 100 318 98" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="5"/>
    <path class="hero-hand__palm" d="M111 91 C99 82 88 76 75 79 L53 88 C42 91 36 101 40 112 C44 123 58 130 74 128 L101 123 C114 118 122 101 111 91 Z"/>
    <g class="hero-hand__thumb">
      <path class="hero-hand__skin" d="M90 100 C99 93 104 83 101 73 L94 48 C91 39 83 34 78 39 C73 43 75 52 77 58 L81 75 C76 80 73 88 74 94"/>
      <path d="M80 43 L84 52" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="4"/>
      <path d="M78 72 Q85 69 93 72" fill="none" stroke-opacity=".35" stroke-width="2"/>
    </g>
    <path class="hero-hand__skin" d="M51 87 C39 82 30 87 31 94 C31 101 41 102 53 104 L64 105 C70 104 72 98 67 95 L54 91 M44 102 C32 99 27 105 31 111 C35 117 49 117 60 117 C66 117 69 112 64 108 M41 116 C32 116 33 123 40 126 C46 129 55 129 62 128"/>
    <path d="M101 97 Q108 106 101 116" fill="none" stroke-opacity=".3" stroke-width="2.5"/>
    <g class="hero-hand__coin" stroke="#6c4112" stroke-width="2.5">
      <ellipse cx="87" cy="34" rx="14" ry="16" fill="#c58a2a"/>
      <ellipse cx="84" cy="33" rx="12" ry="15" fill="#f7ce68"/>
      <ellipse cx="84" cy="33" rx="8" ry="11" fill="none" stroke="#bd8225" stroke-width="1.5"/>
      <path d="M84 25 L86 30 L90 31 L87 34 L87 39 L84 37 L80 39 L81 34 L78 31 L82 30 Z" fill="#fff1bb" stroke="none"/>
    </g>
  </g>
</svg>`;

/** The local player's hand. Gift permission and targeting belong to the controller. */
export class HeroHand {
  constructor({ onGift } = {}) {
    this.onGift = onGift;
    this.state = { available: false, cooldownUntil: 0, reason: "Connecting to the GM…" };
    this._y = null;
    this._frame = null;
    this._flickTimer = null;
    this._onPointerMove = this._onPointerMove.bind(this);
    this._scheduleLayout = this._scheduleLayout.bind(this);
  }

  mount() {
    if (this.element) return this;
    this.element = document.createElement("div");
    this.element.className = "hero-hand";
    this.element.dataset.module = "hero-point-handle-bars";
    this.element.innerHTML = `<button class="hero-hand__button" type="button">${SVG}<span class="hero-hand__status"></span></button>`;
    this.button = this.element.querySelector("button");
    this.status = this.element.querySelector(".hero-hand__status");
    this.button.addEventListener("click", () => {
      if (this.state.available) this.onGift?.();
    });
    document.body.append(this.element);
    window.addEventListener("pointermove", this._onPointerMove, { passive: true });
    window.addEventListener("resize", this._scheduleLayout, { passive: true });
    this._resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(this._scheduleLayout) : null;
    this._mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => !this.element?.contains(record.target))) this._scheduleLayout();
    });
    // Watch replacement of Foundry's UI containers, but not our own animation styles.
    this._mutationObserver.observe(document.body, { childList: true, subtree: true });
    this._clock = window.setInterval(() => {
      this._renderState();
      this._scheduleLayout();
    }, 1000);
    this._renderState();
    this._layout();
    return this;
  }

  setState(state = {}) {
    this.state = { ...this.state, ...state };
    this._renderState();
  }

  /** Play only after the authority confirms a successful gift. */
  flick() {
    if (!this.element) return;
    window.clearTimeout(this._flickTimer);
    this.element.classList.remove("is-flicking");
    // Restart when a GM gives several coins in quick succession.
    void this.element.offsetWidth;
    this.element.classList.add("is-flicking");
    this._flickTimer = window.setTimeout(() => this.element?.classList.remove("is-flicking"), 850);
  }

  destroy() {
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("resize", this._scheduleLayout);
    window.clearInterval(this._clock);
    window.clearTimeout(this._flickTimer);
    if (this._frame !== null) window.cancelAnimationFrame(this._frame);
    this._resizeObserver?.disconnect();
    this._mutationObserver?.disconnect();
    this.element?.remove();
    this.element = null;
    this.button = null;
    this.status = null;
    this._frame = null;
    this._observedSidebar = null;
  }

  _renderState() {
    if (!this.element) return;
    const { available, cooldownUntil, reason } = this.state;
    const remaining = Math.max(0, Number(cooldownUntil || 0) - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const description = available
      ? "Target another player's token, then press H or click to gift a Hero Point."
      : reason || (remaining > 0 ? "The party's next coin is on its way." : "Waiting for the next coin.");
    const label = `${description}${remaining > 0 ? ` (${clock} remaining)` : ""}`;
    this.element.classList.toggle("has-coin", Boolean(available));
    this.element.classList.toggle("is-spent", !available);
    this.button.setAttribute("aria-disabled", String(!available));
    this.button.setAttribute("aria-label", label);
    this.button.title = label;
    this.status.textContent = remaining > 0 ? clock : available ? "H · Gift a Hero Point" : "Thumbs up!";
    const color = String(globalThis.game?.user?.color ?? "#8d78bf");
    this.element.style.setProperty("--hero-hand-color", CSS.supports("color", color) ? color : "#8d78bf");
  }

  _scheduleLayout() {
    if (this._frame !== null || !this.element) return;
    this._frame = window.requestAnimationFrame(() => {
      this._frame = null;
      this._layout();
    });
  }

  _layout() {
    if (!this.element) return;
    // Sidebar is narrower when collapsed. Anchoring to its actual edge follows both modes.
    const sidebar = document.querySelector("#sidebar") ?? document.querySelector("#ui-right");
    if (sidebar !== this._observedSidebar) {
      this._resizeObserver?.disconnect();
      if (sidebar) this._resizeObserver?.observe(sidebar);
      this._observedSidebar = sidebar;
    }
    const rect = sidebar?.getBoundingClientRect();
    const sidebarVisible = rect && rect.width > 0 && rect.height > 0;
    const edge = sidebarVisible ? Math.max(0, Math.min(window.innerWidth, rect.left)) : window.innerWidth;
    const width = Math.min(280, Math.max(120, edge));
    this.element.style.right = `${Math.max(0, window.innerWidth - edge)}px`;
    this.element.style.width = `${width}px`;
    this.element.style.setProperty("--hero-hand-height", `${width * 170 / 320}px`);
    if (this._y === null) this._y = window.innerHeight * 0.58;
    this._place();
  }

  _onPointerMove(event) {
    if (!this.element || event.pointerType === "touch") return;
    if (event.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    const rect = this.element.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right) return;
    // Keep the button still while a person is trying to click or focus it.
    if (this.button?.contains(event.target)) return;
    this._y = event.clientY;
    this._place();
  }

  _place() {
    if (!this.element) return;
    const height = this.button?.getBoundingClientRect().height || 149;
    const y = Math.max(height / 2 + 8, Math.min(window.innerHeight - height / 2 - 24, this._y));
    this.element.style.setProperty("--hero-hand-y", `${y}px`);
  }
}
