const HAND_SCALE = 280 / 320;
const HAND_HEIGHT = 170 * HAND_SCALE;
const MIN_ARM_WIDTH = 640;
const EXPOSED_REACH = 280;

const SVG = `
<svg class="hero-hand__drawing" viewBox="0 0 320 170" aria-hidden="true" focusable="false">
  <g class="hero-hand__gesture" stroke="#241c27" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
    <path class="hero-hand__arm" d="M320 93 C258 96 185 91 120 91 L102 120 C177 112 245 118 320 114 Z"/>
    <path class="hero-hand__arm-highlight" d="M143 96 C211 100 266 100 318 98" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="5"/>
    <path class="hero-hand__palm" d="M111 91 C99 82 88 76 75 79 L53 88 C42 91 36 101 40 112 C44 128 58 138 74 134 L101 123 C114 118 122 101 111 91 Z"/>
    <path class="hero-hand__finger hero-hand__skin" d="M57 86 C46 81 34 82 30 89 C26 97 35 102 46 103 L63 104 C70 104 73 97 67 93 L53 89"/>
    <path class="hero-hand__finger hero-hand__skin" d="M47 101 C35 97 25 101 27 109 C29 116 43 118 58 117 L65 116 C72 113 70 106 64 105 L48 104"/>
    <path class="hero-hand__finger hero-hand__skin" d="M45 115 C34 111 27 116 30 123 C33 130 45 132 59 130 C67 129 69 123 63 119 L48 118"/>
    <path class="hero-hand__finger hero-hand__skin" d="M47 128 C38 124 33 129 37 135 C41 141 51 142 62 137 C68 134 66 128 60 128 L49 130"/>
    <path d="M101 97 Q108 106 101 116" fill="none" stroke-opacity=".3" stroke-width="2.5"/>
    <g class="hero-hand__coin" stroke="#6c4112" stroke-width="2.5">
      <ellipse cx="61" cy="80" rx="17" ry="7" fill="#c58a2a"/>
      <ellipse cx="60" cy="77" rx="17" ry="6" fill="#f7ce68"/>
      <ellipse cx="60" cy="77" rx="12" ry="3.5" fill="none" stroke="#bd8225" stroke-width="1.5"/>
      <path d="M60 74 L63 76 L68 77 L63 78 L60 80 L57 78 L52 77 L57 76 Z" fill="#fff1bb" stroke="none"/>
    </g>
    <g class="hero-hand__thumb">
      <path class="hero-hand__skin" d="M90 100 C99 93 104 83 101 73 L94 48 C91 39 83 34 78 39 C73 43 75 52 77 58 L81 75 C76 80 73 88 74 94"/>
      <path d="M80 43 L84 52" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="4"/>
      <path d="M78 72 Q85 69 93 72" fill="none" stroke-opacity=".35" stroke-width="2"/>
    </g>
  </g>
</svg>`;

/** The local player's hand. Gift permission and targeting belong to the controller. */
export class HeroHand {
  constructor() {
    this.state = { available: false, cooldownUntil: 0, reason: "Connecting to the GM…" };
    this._y = null;
    this._frame = null;
    this._flickTimer = null;
    this._playTimer = null;
    this._sidebarTransitions = new Set();
    this._onPointerMove = this._onPointerMove.bind(this);
    this._scheduleLayout = this._scheduleLayout.bind(this);
    this._onSidebarTransition = this._onSidebarTransition.bind(this);
  }

  mount() {
    if (this.element) return this;
    this.element = document.createElement("div");
    this.element.className = "hero-hand";
    this.element.dataset.module = "hero-point-handle-bars";
    this.element.innerHTML = `<button class="hero-hand__button" type="button">${SVG}<span class="hero-hand__status"></span></button>`;
    this.button = this.element.querySelector("button");
    this.drawing = this.element.querySelector(".hero-hand__drawing");
    this.arm = this.element.querySelector(".hero-hand__arm");
    this.armHighlight = this.element.querySelector(".hero-hand__arm-highlight");
    this.status = this.element.querySelector(".hero-hand__status");
    this.button.addEventListener("click", () => this.play());
    document.body.append(this.element);
    window.addEventListener("pointermove", this._onPointerMove, { passive: true });
    window.addEventListener("resize", this._scheduleLayout, { passive: true });
    for (const event of ["transitionrun", "transitionend", "transitioncancel"]) {
      window.addEventListener(event, this._onSidebarTransition);
    }
    this._resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(this._scheduleLayout) : null;
    this._mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => !this.element?.contains(record.target))) this._scheduleLayout();
    });
    // Follow sidebar replacement, collapse classes, and theme layout changes.
    // Our own layout/style updates are filtered out above to avoid a loop.
    this._mutationObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"]
    });
    this._clock = window.setInterval(() => {
      this._renderState();
      this._scheduleLayout();
    }, 1000);
    this._renderState();
    this._layout();
    return this;
  }

  setState(state = {}) {
    if ("available" in state && Boolean(state.available) !== Boolean(this.state.available)) this._stopPlay();
    this.state = { ...this.state, ...state };
    this._renderState();
  }

  /** A local flourish; playing never spends the coin or invokes gift handling. */
  play() {
    if (!this.element || this._flickTimer !== null) return;
    this._stopPlay();
    void this.element.offsetWidth;
    this.element.classList.add(this.state.available ? "is-playing-coin" : "is-playing-thumb");
    this._playTimer = window.setTimeout(() => this._stopPlay(), 1000);
  }

  _stopPlay() {
    window.clearTimeout(this._playTimer);
    this._playTimer = null;
    this.element?.classList.remove("is-playing-coin", "is-playing-thumb");
  }

  /** Play only after the authority confirms a successful gift. */
  flick() {
    if (!this.element) return;
    this._stopPlay();
    window.clearTimeout(this._flickTimer);
    this.element.classList.remove("is-flicking");
    // Restart when a GM gives several coins in quick succession.
    void this.element.offsetWidth;
    this.element.classList.add("is-flicking");
    this._flickTimer = window.setTimeout(() => {
      this.element?.classList.remove("is-flicking");
      this._flickTimer = null;
    }, 850);
  }

  destroy() {
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("resize", this._scheduleLayout);
    for (const event of ["transitionrun", "transitionend", "transitioncancel"]) {
      window.removeEventListener(event, this._onSidebarTransition);
    }
    window.clearInterval(this._clock);
    window.clearTimeout(this._flickTimer);
    this._flickTimer = null;
    this._stopPlay();
    if (this._frame !== null) window.cancelAnimationFrame(this._frame);
    this._resizeObserver?.disconnect();
    this._mutationObserver?.disconnect();
    this.element?.remove();
    this.element = null;
    this.button = null;
    this.drawing = null;
    this.arm = null;
    this.armHighlight = null;
    this.status = null;
    this._frame = null;
    this._observedSidebar = null;
    this._sidebarTransitions.clear();
  }

  _renderState() {
    if (!this.element) return;
    const { available, cooldownUntil, reason } = this.state;
    const remaining = Math.max(0, Number(cooldownUntil || 0) - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const description = available
      ? "Click to play with your coin. Target another player's token and press H to gift a Hero Point."
      : `Click to wiggle your thumb. ${reason || (remaining > 0 ? "The party's next coin is on its way." : "Waiting for the next coin.")}`;
    const label = `${description}${remaining > 0 ? ` (${clock} remaining)` : ""}`;
    this.element.classList.toggle("has-coin", Boolean(available));
    this.element.classList.toggle("is-spent", !available);
    this.button.setAttribute("aria-label", label);
    this.button.title = label;
    this.status.textContent = remaining > 0 ? `${clock} · Click to play` : available ? "Click · Play / H · Gift" : "Click · Thumb wiggle";
    const color = String(globalThis.game?.user?.color ?? "#8d78bf");
    this.element.style.setProperty("--hero-hand-color", CSS.supports("color", color) ? color : "#8d78bf");
  }

  _scheduleLayout() {
    if (this._frame !== null || !this.element) return;
    this._frame = window.requestAnimationFrame(() => {
      this._frame = null;
      this._layout();
      if (this._sidebarTransitions.size) this._scheduleLayout();
    });
  }

  _onSidebarTransition(event) {
    if (event.target !== this._observedSidebar) return;
    if (event.type === "transitionrun") this._sidebarTransitions.add(event.propertyName);
    else this._sidebarTransitions.delete(event.propertyName);
    this._scheduleLayout();
  }

  _layout() {
    if (!this.element) return;
    // The sleeve always reaches the screen's far edge. Closing the panel moves
    // the entire drawing right, with the excess clipped by the viewport.
    const sidebar = document.querySelector("#sidebar-content")
      ?? document.querySelector("#sidebar") ?? document.querySelector("#ui-right");
    if (sidebar !== this._observedSidebar) {
      this._sidebarTransitions.clear();
      this._resizeObserver?.disconnect();
      if (sidebar) this._resizeObserver?.observe(sidebar);
      // A collapsing panel can move without changing its own width; the outer
      // sidebar's changing width keeps the attachment in sync with that slide.
      if (sidebar?.parentElement) this._resizeObserver?.observe(sidebar.parentElement);
      this._observedSidebar = sidebar;
    }
    const rect = sidebar?.getBoundingClientRect();
    const sidebarVisible = rect && rect.width > 0 && rect.height > 0;
    let sidebarWidth = 0;
    let retraction = 0;
    if (sidebarVisible) {
      const style = window.getComputedStyle(sidebar);
      // Bounds are viewport pixels; computed margins need the same UI scaling.
      const scale = sidebar.offsetWidth > 0 ? rect.width / sidebar.offsetWidth : 1;
      const marginLeft = (Number.parseFloat(style.marginLeft) || 0) * scale;
      const marginRight = Math.max(0, Number.parseFloat(style.marginRight) || 0) * scale;
      const span = Math.max(0, rect.width + marginLeft + marginRight);
      const visible = Math.max(0, Math.min(span, window.innerWidth - rect.left + marginLeft));
      retraction = span - visible;
      // Only the sleeve length changes for a wider sidebar; never scale the hand.
      sidebarWidth = rect.width + Math.max(0, marginLeft) + marginRight;
    }
    const width = Math.min(window.innerWidth, Math.max(MIN_ARM_WIDTH, sidebarWidth + EXPOSED_REACH));
    // Leave the hand and a short sleeve visible even on very narrow viewports.
    retraction = Math.min(retraction, Math.max(0, width - 120));
    const left = window.innerWidth - width + retraction;
    this.element.style.setProperty("--hero-hand-left", `${left}px`);
    this.element.style.setProperty("--hero-hand-width", `${width}px`);
    this.element.style.setProperty("--hero-hand-height", `${HAND_HEIGHT}px`);
    const end = width / HAND_SCALE;
    this.drawing.setAttribute("viewBox", `0 0 ${end} 170`);
    this.arm.setAttribute("d", `M${end} 93 C${end - 62} 96 185 91 120 91 L102 120 C177 112 ${end - 75} 118 ${end} 114 Z`);
    this.armHighlight.setAttribute("d", `M143 96 C211 100 ${end - 54} 100 ${end - 2} 98`);
    if (this._y === null) this._y = window.innerHeight * 0.58;
    this._place();
  }

  _onPointerMove(event) {
    if (!this.element || event.pointerType === "touch") return;
    if (event.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    const rect = this.button.getBoundingClientRect();
    // The off-screen sleeve is excluded from the viewport-height follow strip.
    if (event.clientX < Math.max(0, rect.left) || event.clientX > Math.min(window.innerWidth, rect.right)) return;
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
