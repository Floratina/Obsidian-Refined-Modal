const { WorkspaceLeaf, WorkspaceTabs, TFolder } = require("obsidian");

const EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const NOTE_DEFAULTS = {
  noteAnimEnabled: true,
  noteDuration: 240,
  noteExitDuration: 100,
  noteDistance: 20,
  noteEase: EASING,
  noteUnknownDuration: 400,
  noteUnknownExitDuration: 100,
  noteUnknownDistance: 10,
  noteUnknownEase: EASING,
  noteModeDuration: 400,
  noteModeExitDuration: 100,
  noteModeDistance: 10,
  noteModeEase: EASING,
};
const MODE_START_DELAY = 100;
const LOADED_NOTE_HANDOFF = 0.5;
const LOADED_NOTE_DISTANCE_FACTOR = 1.5;
const MAX_WAIT = 1200;
const TOOLBAR_SELECTOR = ".editingToolbarModalBar, .editingToolbarPopoverBar, #editingToolbarModalBar, #editingToolbarPopoverBar";

function bounded(value, fallback, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
}

function isValidNoteEasing(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    // Validate against the animation engine, including cubic-bezier and steps.
    // CSS-wide keywords and unresolved var() values cannot be used by this API.
    new KeyframeEffect(null, [], { easing: value });
    return true;
  } catch {
    return false;
  }
}

function filePath(leaf) {
  return leaf?.view?.file?.path ?? leaf?.getViewState?.().state?.file ?? null;
}

// Animate the scrolling document, leaving editor chrome and toolbar siblings untouched.
function noteViewport(view) {
  if (view?.getViewType() !== "markdown") return null;
  const mode = view.getMode?.() ?? view.containerEl?.getAttribute("data-mode");
  return view.contentEl?.querySelector(mode === "preview"
    ? ".markdown-reading-view .markdown-preview-view"
    : ".markdown-source-view .cm-scroller") ?? null;
}

// Include scroll clipping and occlusion; virtual-list overscan is not visibility.
function visibleBox(el) {
  if (!el?.isConnected || !el.getClientRects().length) return null;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const rect = el.getBoundingClientRect();
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(win.innerWidth, rect.right), bottom = Math.min(win.innerHeight, rect.bottom);
  for (let parent = el.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none") return null;
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX + style.overflowY)) {
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
    }
  }
  if (right <= left || bottom <= top) return null;
  const x = (left + right) / 2, y = (top + bottom) / 2;
  const hit = doc.elementFromPoint(x, y);
  return hit && el.contains(hit) ? { x, y } : null;
}

class NoteTransitions {
  constructor(plugin) {
    this.plugin = plugin;
    this.workspace = plugin.app.workspace;
    this.transitions = new Map();
    this.navigations = new WeakMap();
    this.intent = null;
    this.stopped = false;
  }

  start() {
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.updateSettings();
    this.plugin.registerDomEvent(document, "pointerdown", (event) => this.safely(() => {
      this.intent = null;
      const target = event.target?.closest?.(".view-content, .view-header");
      if (target) this.cancelIn(target.closest(".workspace-tabs"));
      if (!this.enabled() || event.button !== 0 || this.modified(event)) return;
      if (!this.rememberTab(event.target)) this.rememberList(event.target);
    }), { capture: true, passive: true });
    this.plugin.registerDomEvent(document, "click", (event) => this.safely(() => {
      if (!this.enabled() || event.button !== 0 || this.modified(event) || event.defaultPrevented) return;
      // Older hosts without the tab-selection method retain the click fallback.
      if (this.hasTabHook) return;
      const leaf = this.rememberTab(event.target);
      if (!leaf) return;
      // Obsidian selects the tab before setActiveLeaf: capture before its click handler.
      const transition = this.prepare(leaf, filePath(leaf));
      if (transition) queueMicrotask(() => this.safely(() => {
        if (this.shownLeaf(leaf.parent) !== leaf) this.cancel(transition);
        else this.ready(transition);
      }));
    }), { capture: true, passive: true });
    this.plugin.registerDomEvent(document, "keydown", () => {
      this.intent = null;
      this.cancelAll();
    }, { capture: true });
    this.plugin.registerDomEvent(document, "wheel", (event) => {
      const group = event.target?.closest?.(".workspace-tabs");
      if (group) this.cancelIn(group);
    }, { capture: true, passive: true });
    this.plugin.registerDomEvent(window, "resize", () => this.cancelAll());
    const motionChanged = () => this.updateSettings();
    this.motion.addEventListener("change", motionChanged);
    this.plugin.register(() => this.motion.removeEventListener("change", motionChanged));

    this.wrap(WorkspaceLeaf.prototype, "openFile", (leaf, [file, options]) => {
      if (leaf.workspace !== this.workspace || file?.extension !== "md") return null;
      if (options?.active === false && this.shownLeaf(leaf.parent) !== leaf) return null;
      return this.prepare(leaf, file.path);
    }, true);
    this.wrap(WorkspaceLeaf.prototype, "setViewState", (leaf, args) => this.beforeViewState(leaf, args), true);
    this.wrap(this.workspace, "revealLeaf", (_workspace, [leaf]) => this.activate(leaf), true);
    this.wrap(this.workspace, "setActiveLeaf", (_workspace, [leaf]) => this.activate(leaf), false);
    // Tab selection changes currentTab and hides the old leaf before setActiveLeaf.
    // Capture at that boundary, including tab switches handled before DOM click.
    this.hasTabHook = typeof WorkspaceTabs?.prototype?.selectTabIndex === "function";
    if (this.hasTabHook) this.wrap(WorkspaceTabs.prototype, "selectTabIndex", (group, [index]) => {
      const target = group.children?.[index];
      if (!target || target.workspace !== this.workspace || target === this.shownLeaf(group)) return null;
      // Keep the actual input source. Revealing an existing tab through a link or
      // file opener does not turn that action into a click on the tab bar.
      return this.prepare(target, filePath(target));
    }, false);

    const refresh = () => this.safely(() => {
      for (const transition of this.transitions.values()) {
        if (!transition.host.isConnected || transition.target.parent !== transition.group) this.cancel(transition);
        else this.ready(transition);
      }
    });
    this.plugin.registerEvent(this.workspace.on("file-open", refresh));
    this.plugin.registerEvent(this.workspace.on("active-leaf-change", refresh));
    this.plugin.registerEvent(this.workspace.on("layout-change", refresh));
  }

  beforeViewState(leaf, args) {
    const state = args[0];
    if (leaf.workspace !== this.workspace || state?.type !== "markdown") return null;
    if (state.active === false && this.shownLeaf(leaf.parent) !== leaf) return null;
    const path = state.state?.file ?? filePath(leaf);
    const transition = this.prepare(leaf, path, state.state?.mode);
    if (transition && !transition.modeChange && filePath(leaf) !== path) {
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file?.extension === "md") {
        // Copy caller-owned state, retaining scroll, history and other options.
        args[0] = { ...state, state: this.initialViewState(file, state.state ?? {}) };
      }
    }
    return transition;
  }

  initialViewState(file, state) {
    const app = this.plugin.app;
    const force = app.plugins?.getPlugin?.("obsidian-view-mode-by-frontmatter");
    const settings = force?.settings;
    if (!settings || (settings.ignoreOpenFiles && force.openedFiles?.includes(file.basename))) return state;

    // Match Force note view mode's rule order: folders, filename patterns,
    // note properties, then the vault default. Read its live settings only.
    let rule = null;
    const applyRule = (value) => {
      if (typeof value !== "string") return;
      const [key, mode] = value.split(":").map((part) => part.trim());
      if (key === "default") { rule = null; return; }
      if (!["source", "preview", "live"].includes(mode)) return;
      rule = { mode };
      if (key === "obsidianEditingMode") {
        rule.source = mode !== "live";
        if (mode === "live") rule.mode = "source";
      } else if (key === "obsidianUIMode") rule.source = false;
    };
    for (const item of settings.folders ?? []) {
      if (!item.folder || !item.viewMode) continue;
      const folder = app.vault.getAbstractFileByPath(item.folder);
      if (folder instanceof TFolder && file.parent
        && (file.parent === folder || file.parent.path.startsWith(folder.path))) applyRule(item.viewMode);
    }
    for (const item of settings.files ?? []) {
      if (!item.filePattern || !item.viewMode) continue;
      // The companion plugin matches basenames, including for patterns with '/'.
      let matches = false;
      try { matches = !!file.basename.match(item.filePattern); } catch { continue; }
      if (matches) applyRule(item.viewMode);
    }
    if (rule) return { ...state, ...rule };

    const properties = app.metadataCache.getFileCache(file)?.frontmatter;
    const mode = properties?.obsidianUIMode;
    const editing = properties?.obsidianEditingMode;
    if (mode || editing) {
      const resolved = { ...state };
      if (mode === "source" || mode === "preview") resolved.mode = mode;
      if (editing === "source" || editing === "live") resolved.source = editing === "source";
      return resolved;
    }
    if (settings.ignoreForceViewAll) return state;
    return {
      ...state,
      mode: app.vault.getConfig("defaultViewMode") || "source",
      source: app.vault.getConfig("livePreview") === false,
    };
  }

  // Preserve the host's return value, errors and later plugins' wrapper chains.
  wrap(object, name, before, asynchronous) {
    const original = object[name];
    if (typeof original !== "function") return;
    const own = Object.prototype.hasOwnProperty.call(object, name);
    const manager = this;
    const wrapped = function (...args) {
      const transition = manager.stopped ? null : manager.safely(() => before(this, args));
      if (transition && asynchronous) transition.holds++;
      let result;
      try { result = original.apply(this, args); }
      catch (error) {
        if (transition) manager.cancel(transition);
        throw error;
      }
      if (transition) {
        if (asynchronous) {
          Promise.resolve(result).then(() => manager.safely(() => {
            transition.holds--;
            if (transition.playing) manager.animateIncoming(transition);
            else manager.ready(transition);
          }), () => manager.cancel(transition));
        } else manager.safely(() => manager.ready(transition));
      }
      return result;
    };
    object[name] = wrapped;
    this.plugin.register(() => {
      if (object[name] !== wrapped) return;
      if (own) object[name] = original;
      else delete object[name];
    });
  }

  safely(callback) {
    try { return callback(); }
    catch (error) {
      this.cancelAll();
      if (!this.reportedError) {
        this.reportedError = true;
        console.error("[Refined Modal] Note transition skipped", error);
      }
      return null;
    }
  }

  modified(event) { return event.ctrlKey || event.metaKey || event.altKey || event.shiftKey; }

  enabled() {
    return !this.stopped && !!this.plugin.settings.noteAnimEnabled && !this.motion.matches;
  }

  updateSettings() {
    document.body.classList.toggle("flra-note-anim", !this.stopped && !!this.plugin.settings.noteAnimEnabled);
    if (!this.enabled()) this.cancelAll();
  }

  shownLeaf(group) {
    return group?.children?.[group.currentTab] ?? null;
  }

  supported(leaf) {
    return leaf?.getRoot?.() === this.workspace.rootSplit
      && leaf.view?.containerEl?.ownerDocument === document
      && !leaf.parent?.isStacked;
  }

  rememberTab(target) {
    if (target?.closest?.(".workspace-tab-header-inner-close-button")) return null;
    const header = target?.closest?.(".workspace-tab-header");
    if (!header) return null;
    let leaf = null;
    this.workspace.iterateAllLeaves((item) => { if (item.tabHeaderEl === header) leaf = item; });
    if (leaf) this.intent = { kind: "tab", leaf, time: performance.now() };
    return leaf;
  }

  rememberList(target) {
    const row = target?.closest?.(".nn-file[data-path], .nav-file-title[data-path]");
    const root = row?.closest(".nn-list-pane, .workspace-leaf-content[data-type='file-explorer']");
    const destination = visibleBox(row);
    if (!root || !destination) return;
    const path = row.getAttribute("data-path");
    const directions = new Map();
    this.workspace.iterateAllLeaves((leaf) => {
      if (!this.supported(leaf) || this.shownLeaf(leaf.parent) !== leaf || leaf.view?.getViewType() !== "markdown") return;
      const pathA = filePath(leaf);
      if (!pathA || pathA === path) return;
      const selector = row.matches(".nn-file") ? ".nn-file" : ".nav-file-title";
      const candidates = root.querySelectorAll(`${selector}[data-path="${CSS.escape(pathA)}"]`);
      // Repeated entries (for example pinned notes) must have one unambiguous visible position.
      const positions = Array.from(candidates, visibleBox).filter(Boolean);
      if (positions.length === 1) directions.set(leaf, Math.sign(destination.y - positions[0].y));
    });
    this.intent = { kind: "list", path, directions, time: performance.now() };
  }

  direction(source, target, path) {
    const intent = this.intent;
    if (!intent || performance.now() - intent.time > 1000) return { x: 0, y: 0 };
    if (intent.kind === "list" && intent.path === path) return { x: 0, y: intent.directions.get(source) ?? 0 };
    if (intent.kind === "tab" && intent.leaf === target && source.parent === target.parent) {
      const a = source.tabHeaderEl?.getBoundingClientRect(), b = target.tabHeaderEl?.getBoundingClientRect();
      // Tab direction does not depend on a hit-test through theme overlays.
      const geometry = a?.width > 0 && b?.width > 0 ? Math.sign((b.left + b.width / 2) - (a.left + a.width / 2)) : 0;
      const tabs = source.parent.children;
      return { x: geometry || Math.sign(tabs.indexOf(target) - tabs.indexOf(source)), y: 0 };
    }
    return { x: 0, y: 0 };
  }

  activate(leaf) {
    const pending = this.transitions.get(leaf?.parent);
    // openFile may activate the leaf while its old file is still loaded.
    if (pending?.target === leaf) return pending.playing ? null : pending;
    return this.prepare(leaf, filePath(leaf));
  }

  prepare(target, path, targetMode) {
    if (!this.enabled() || !this.supported(target) || !path?.toLowerCase().endsWith(".md")) return null;
    const modalOpen = !!document.querySelector(".modal-container:not(.modal-zombie)");
    const group = target.parent;
    const source = this.shownLeaf(group);
    const modeChange = source === target && filePath(source) === path
      && (targetMode === "source" || targetMode === "preview")
      && source.view?.getViewType() === "markdown" && source.view.getMode() !== targetMode;
    const previous = this.transitions.get(group);
    const navigation = this.navigations.get(group.containerEl);
    // Automatic mode corrections belong to the file navigation, even if its
    // visual animation has finished. User input clears this marker first.
    if (modeChange && navigation?.target === target && navigation.path === path) {
      return previous?.target === target && previous.path === path ? previous : null;
    }
    if (previous?.target === target && previous.path === path && !(previous.playing && modeChange)) {
      return previous.playing ? null : previous;
    }
    this.cancel(previous);
    if (!source) return null;
    if (filePath(source) === path && !modeChange) return null;
    const content = noteViewport(source.view);
    const host = group.containerEl;
    const hostRect = host?.getBoundingClientRect();
    if (!hostRect || hostRect.width < 1 || hostRect.height < 1) return null;

    const direction = modeChange || modalOpen || !content ? { x: 0, y: 0 } : this.direction(source, target, path);
    const floating = !direction.x && !direction.y;
    let layer = null, surface = null, scrolls = [];
    // New/empty panes and modal-driven opens can still float in without capturing
    // an absent or temporarily scaled background page.
    const rect = !modalOpen && content?.getClientRects().length ? content.getBoundingClientRect() : null;
    if (rect?.width > 0 && rect.height > 0) {
      ({ surface, scrolls } = this.snapshot(source, content));
      layer = host.createDiv({ cls: "flra-note-layer", attr: { "aria-hidden": "true" } });
      layer.inert = true;
      Object.assign(layer.style, {
        left: `${rect.left - hostRect.left - host.clientLeft}px`,
        top: `${rect.top - hostRect.top - host.clientTop}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      });
    }
    // Classify the actual destination view before navigation. A different open
    // tab containing this file does not make a fresh load in this leaf cached.
    const sharedAxis = !!surface && !floating && !modeChange && !target.isDeferred
      && target.view?.getViewType() === "markdown" && target.view.file?.path === path;
    const transition = { target, path, group, host, layer, surface, direction, floating, modeChange, sharedAxis, holds: 0, animations: [], clips: new Set() };
    this.transitions.set(group, transition);
    if (!modeChange) this.navigations.set(host, { target, path });
    // Hide the renderer only while the host's navigation calls are in flight.
    // The snapshot starts its continuous exit immediately.
    target.containerEl.classList.add("flra-note-pending");
    if (layer) {
      host.classList.add("flra-note-host");
      layer.appendChild(surface);
    }
    for (const [clone, top, left] of scrolls) { clone.scrollTop = top; clone.scrollLeft = left; }
    // Never keep an old page covering a failed, cancelled or slow navigation.
    transition.timer = window.setTimeout(() => this.cancel(transition), MAX_WAIT);
    this.startExit(transition);
    return transition;
  }

  startExit(transition) {
    if (transition.started != null) return;
    transition.started = performance.now();
    transition.settings = this.animationSettings(transition);
    const { duration, exitDuration, distance, easing } = transition.settings;
    if (!transition.surface) return;
    // Keep the shared-axis movement while allowing the new page to fade in
    // as soon as navigation completes, overlapping the remaining old-page exit.
    if (!transition.modeChange && !transition.floating) {
      // Compensate for the visible exit portion, then apply the extra multiplier.
      const travel = transition.sharedAxis
        ? distance * LOADED_NOTE_DISTANCE_FACTOR / LOADED_NOTE_HANDOFF : distance;
      const movement = transition.surface.animate([
        { transform: "translate(0, 0)" },
        { transform: `translate(${-transition.direction.x * travel}px, ${-transition.direction.y * travel}px)` },
      ], { duration: exitDuration + duration, easing, fill: "both" });
      transition.animations.push(movement);
      movement.finished.catch(() => {});
    }
    // Reverse the entrance fade for note exits: the default easing retains the
    // old picture longer, then clears it quickly as the new page appears.
    // Explicit mode switches keep their existing fade and blank interval.
    // Already-loaded notes share one eased timeline. The fade-out ends and
    // fade-in begins at 50% progress, without a separate blank-time interval.
    const frames = transition.sharedAxis ? [
      { opacity: 1, offset: 0 },
      { opacity: 0, offset: LOADED_NOTE_HANDOFF },
      { opacity: 0, offset: 1 },
    ] : transition.modeChange ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 0 }, { opacity: 1 }];
    const animation = transition.surface.animate(frames, {
      duration: transition.sharedAxis ? exitDuration + duration : exitDuration, easing, fill: "both",
      direction: transition.sharedAxis || transition.modeChange ? "normal" : "reverse",
    });
    transition.animations.push(animation);
    transition.exitFinished = animation.finished.then(() => this.safely(() => {
      if (!this.current(transition)) return;
      transition.layer?.remove();
      transition.layer = null;
      transition.surface = null;
    }), () => {});
  }

  snapshot(leaf, content) {
    const clone = content.cloneNode(true);
    const scrolls = [[clone, content.scrollTop, content.scrollLeft]];
    // Read layout only for scroll containers, not for every text node's parent.
    const scrollSelector = ".cm-scroller, .markdown-preview-view, .cm-table-widget, .table-wrapper, pre";
    const originalScrollers = content.querySelectorAll(scrollSelector);
    const clonedScrollers = clone.querySelectorAll(scrollSelector);
    originalScrollers.forEach((from, index) => {
      if (from.scrollTop || from.scrollLeft) scrolls.push([clonedScrollers[index], from.scrollTop, from.scrollLeft]);
    });
    const originalCanvases = content.querySelectorAll("canvas");
    clone.querySelectorAll("canvas").forEach((to, index) => {
      const from = originalCanvases[index];
      if (from.width && from.height) {
        try { to.getContext("2d")?.drawImage(from, 0, 0); } catch { /* Unsupported embedded canvas. */ }
      }
    });
    // Remove plugin chrome while its identifying attributes are still present.
    clone.querySelectorAll(TOOLBAR_SELECTOR).forEach((el) => el.remove());
    for (const to of [clone, ...clone.querySelectorAll("*")]) {
      for (const attr of Array.from(to.attributes)) {
        if (attr.name === "id" || attr.name.startsWith("on")) to.removeAttribute(attr.name);
      }
      if (to.hasAttribute("contenteditable")) to.setAttribute("contenteditable", "false");
    }
    // Do not start additional media, scripts or embedded browsing contexts in a visual copy.
    clone.querySelectorAll("script, iframe, webview, video, audio").forEach((el) => el.remove());
    clone.classList.add("flra-note-snapshot-viewport");
    let surface = clone;
    // Keep each ancestor's original border box and inline theme variables.
    // Flattening every ancestor to the viewport's size changes editor layout.
    const boxes = [[content, clone]];
    for (let parent = content.parentElement; parent; parent = parent.parentElement) {
      const frame = parent.cloneNode(false);
      frame.removeAttribute("id");
      frame.classList.remove("flra-note-clip", "flra-note-pending");
      frame.classList.add("flra-note-snapshot-frame");
      frame.appendChild(surface);
      boxes.push([parent, frame]);
      surface = frame;
      if (parent === leaf.containerEl) break;
    }
    const viewportRect = content.getBoundingClientRect();
    const rects = boxes.map(([original]) => original.getBoundingClientRect());
    boxes.forEach(([original, copy], index) => {
      const rect = rects[index];
      const parentRect = rects[index + 1] ?? viewportRect;
      const parent = boxes[index + 1]?.[0];
      const geometry = {
        left: `${rect.left - parentRect.left - (parent?.clientLeft ?? 0)}px`,
        top: `${rect.top - parentRect.top - (parent?.clientTop ?? 0)}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      };
      for (const [property, value] of Object.entries(geometry)) copy.style.setProperty(property, value, "important");
      // Preserve inherited typography when the snapshot leaves the live leaf.
      const style = original.ownerDocument.defaultView.getComputedStyle(original);
      for (const property of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "color", "text-align"]) {
        copy.style.setProperty(property, style.getPropertyValue(property));
      }
    });
    // Animate a neutral wrapper, so the snapshot's own opacity and transforms
    // are not replaced by the first animation keyframe.
    const motion = content.ownerDocument.createElement("div");
    motion.className = "flra-note-snapshot";
    motion.appendChild(surface);
    return { surface: motion, scrolls };
  }

  current(transition) {
    return !this.stopped && this.transitions.get(transition.group) === transition;
  }

  animationSettings(transition) {
    const prefix = transition.modeChange ? "noteMode" : transition.floating ? "noteUnknown" : "note";
    const settings = this.plugin.settings;
    const number = (suffix, max) => bounded(settings[prefix + suffix], NOTE_DEFAULTS[prefix + suffix], max);
    const easing = settings[prefix + "Ease"];
    return {
      duration: number("Duration", 600),
      exitDuration: number("ExitDuration", 600),
      distance: number("Distance", 60),
      easing: isValidNoteEasing(easing) ? easing : EASING,
    };
  }

  ready(transition) {
    if (!this.current(transition) || transition.holds || transition.queued || transition.playing) return;
    if (this.shownLeaf(transition.group) !== transition.target) return;
    transition.queued = true;
    // Only explicit mode switches retain the user's intentional blank interval.
    Promise.all([
      transition.target.loadIfDeferred?.(),
      transition.modeChange ? transition.exitFinished : undefined,
    ]).then(() => this.safely(() => {
      if (!this.current(transition)) return;
      if (transition.modeChange) {
        transition.startTimer = window.setTimeout(() => this.safely(() => this.play(transition)), MODE_START_DELAY);
      } else this.play(transition);
    }), () => this.cancel(transition));
  }

  play(transition) {
    if (!this.current(transition)) return;
    if (!this.enabled() || this.shownLeaf(transition.group) !== transition.target
      || filePath(transition.target) !== transition.path) {
      this.cancel(transition);
      return;
    }
    if (transition.holds) {
      // A nested mode update started after readiness was queued. Its completion
      // will try again; do not cancel the transition or add a fixed frame delay.
      transition.queued = false;
      return;
    }
    const incoming = noteViewport(transition.target.view);
    if (!incoming) {
      this.cancel(transition);
      return;
    }
    const { duration, exitDuration, distance, easing } = transition.settings;
    const x = transition.floating ? 0 : transition.direction.x * distance;
    const y = transition.floating ? distance : transition.direction.y * distance;
    const translate = (factor) => `translate(${x * factor}px, ${y * factor}px)`;
    transition.playing = true;
    // Loaded destinations join the outgoing clock. If unexpected host work
    // outlasted that whole animation, give the new page a full ordinary entry.
    const now = performance.now();
    const sharedAxis = transition.sharedAxis && now - transition.started < exitDuration + duration;
    if (!sharedAxis) transition.started = now;
    transition.totalDuration = sharedAxis ? exitDuration + duration : duration;
    const fadeFrames = sharedAxis ? [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: LOADED_NOTE_HANDOFF },
      { opacity: 1, offset: 1 },
    ] : [{ opacity: 0 }, { opacity: 1 }];
    // Compensate for the hidden initial movement before applying the multiplier.
    const travelFactor = sharedAxis ? LOADED_NOTE_DISTANCE_FACTOR / (1 - LOADED_NOTE_HANDOFF) : 1;
    transition.incomingEffects = [
      { frames: [{ transform: translate(travelFactor) }, { transform: "translate(0, 0)" }],
        options: { duration: transition.totalDuration, easing, fill: "both" } },
      { frames: fadeFrames,
        options: { duration: transition.totalDuration, easing, fill: "both" } },
    ];
    this.animateIncoming(transition);
    transition.target.containerEl.classList.remove("flra-note-pending");
    // Follow source/reading-mode replacements on the same timeline, without moving toolbars.
    transition.observer = new MutationObserver(() => this.safely(() => this.animateIncoming(transition)));
    transition.observer.observe(transition.target.view.containerEl, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["data-mode"],
    });
    window.clearTimeout(transition.timer);
    transition.timer = window.setTimeout(() => this.cancel(transition), transition.totalDuration + 100);
    Promise.allSettled(transition.animations.map((animation) => animation.finished))
      .then(() => this.cancel(transition));
  }

  animateIncoming(transition) {
    if (!this.current(transition)) return;
    const incoming = noteViewport(transition.target.view);
    if (!incoming || incoming === transition.incoming) return;
    const elapsed = Math.min(transition.totalDuration, performance.now() - transition.started);
    transition.incoming = incoming;
    const clip = incoming.parentElement;
    clip.classList.add("flra-note-clip");
    transition.clips.add(clip);
    for (const { frames, options } of transition.incomingEffects) {
      const animation = incoming.animate(frames, options);
      animation.currentTime = elapsed;
      transition.animations.push(animation);
      // A mode replacement joins the same timeline rather than restarting it.
      animation.finished.catch(() => {});
    }
  }

  cancel(transition) {
    if (!transition || transition.cancelled) return;
    transition.cancelled = true;
    window.clearTimeout(transition.timer);
    window.clearTimeout(transition.startTimer);
    transition.observer?.disconnect();
    for (const animation of transition.animations) animation.cancel();
    for (const clip of transition.clips) clip.classList.remove("flra-note-clip");
    transition.layer?.remove();
    if (this.transitions.get(transition.group) === transition) {
      transition.target.containerEl.classList.remove("flra-note-pending");
      this.transitions.delete(transition.group);
      transition.host.classList.remove("flra-note-host");
    }
  }

  cancelIn(host) {
    if (host) this.navigations.delete(host);
    for (const transition of this.transitions.values()) if (transition.host === host) this.cancel(transition);
  }

  cancelAll() {
    this.navigations = new WeakMap();
    for (const transition of this.transitions.values()) this.cancel(transition);
  }

  destroy() {
    this.stopped = true;
    this.intent = null;
    this.cancelAll();
    document.body.classList.remove("flra-note-anim");
  }
}

module.exports = { NoteTransitions, NOTE_DEFAULTS, isValidNoteEasing };
