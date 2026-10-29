const { NAVIGATOR_OPTIONS } = require("./notebook-navigator-settings");

const ROOT = ".nn-split-container";
const ELIGIBLE = "body:not(.is-mobile) .mod-left-split .nn-split-container.nn-dual-pane.nn-orientation-horizontal";
const element = (node) => node?.nodeType === 1 ? node : null;
const containsPoint = (el, event) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && event.clientX >= r.left && event.clientX <= r.right &&
    event.clientY >= r.top && event.clientY <= r.bottom;
};

// Observe the existing panes without changing Navigator's settings or drag payloads.
class NotebookNavigatorDrawer {
  constructor(plugin, doc) {
    this.plugin = plugin;
    this.doc = doc;
    this.win = doc.defaultView;
    this.drawers = new Map();
    this.disposers = [];
    this.frame = 0;
    this.active = false;
    this.destroyed = false;
    this.dragTimer = 0;
    this.dragFinishTimer = 0;
    this.dragging = false;
    this.internalFileDrag = false;
    this.media = this.win.matchMedia("(hover: hover) and (pointer: fine)");
    this.mediaListener = () => this.refresh();
    this.media.addEventListener("change", this.mediaListener);
  }

  refresh() {
    if (this.destroyed) return;
    const enabled = !!this.plugin.settings.nnEnabled;
    if (enabled && !this.active) this.start();
    else if (!enabled && this.active) this.stop();
    if (this.active) {
      this.scan();
      for (const drawer of this.drawers.values()) drawer.applySettings();
    }
  }

  listen(target, type, handler, options = true) {
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  start() {
    this.active = true;
    this.observer = new this.win.MutationObserver((records) => {
      // Row selection, virtual scrolling and our own state classes need no rescan.
      const changed = records.some((r) => {
        if (r.type === "attributes") {
          if (!r.target.matches(ROOT)) return false;
          const layout = (value) => (value || "").split(/\s+/).filter((c) => c.startsWith("nn-")).sort().join(" ");
          return layout(r.oldValue) !== layout(r.target.className);
        }
        if (element(r.target)?.matches(ROOT)) return true;
        return [...r.addedNodes, ...r.removedNodes].some((node) => {
          const el = element(node);
          return el && (el.matches(ROOT) || el.querySelector(ROOT));
        });
      });
      if (changed) this.scheduleScan();
    });
    this.observer.observe(this.doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });

    this.listen(this.doc, "dragstart", (event) => {
      this.dragging = true;
      this.internalFileDrag = !!element(event.target)?.closest('[data-drag-type="file"], .nav-file');
      for (const drawer of this.drawers.values()) drawer.beginDrag();
    });
    const dragOver = (event) => {
      if (!this.plugin.settings.nnDragEnabled) return;
      const types = Array.from(event.dataTransfer?.types || []);
      if (!this.internalFileDrag && !types.some((t) => ["Files", "obsidian/file", "obsidian/files", "text/plain", "text/uri-list"].includes(t))) return;
      if (!this.dragging) {
        this.dragging = true;
        for (const drawer of this.drawers.values()) drawer.beginDrag();
      }
      for (const drawer of this.drawers.values()) drawer.dragOver(event);
      // External drags can end outside this window without a local dragend.
      this.win.clearTimeout(this.dragTimer);
      this.dragTimer = this.win.setTimeout(() => this.finishDrag(), 1800);
      // No preventDefault, stopPropagation or dropEffect: Navigator owns the drop.
    };
    this.listen(this.doc, "dragenter", dragOver);
    this.listen(this.doc, "dragover", dragOver);
    this.listen(this.doc, "dragleave", (event) => {
      if (!event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0 ||
        event.clientX >= this.win.innerWidth || event.clientY >= this.win.innerHeight ||
        event.target === this.doc.body || event.target === this.doc.documentElement)) this.finishDrag();
    });
    // Finish after all drop/dragend handlers, including Navigator's file operation.
    // A microtask from a capture listener can run before the target's handler.
    const scheduleDragFinish = () => {
      if (this.dragFinishTimer) return;
      this.dragFinishTimer = this.win.setTimeout(() => {
        this.dragFinishTimer = 0;
        this.finishDrag();
      }, 0);
    };
    this.listen(this.doc, "drop", scheduleDragFinish);
    this.listen(this.doc, "dragend", scheduleDragFinish);
    this.listen(this.win, "blur", (event) => {
      // Descendant controls also emit blur when Navigator moves focus on click.
      // Only loss of focus by the window should dismiss the drawer.
      if (event.target !== this.win) return;
      this.finishDrag();
      for (const drawer of this.drawers.values()) drawer.dismiss();
    }, false);
    this.listen(this.doc, "keydown", (event) => {
      if (event.key === "Escape") {
        this.finishDrag();
        for (const drawer of this.drawers.values()) drawer.dismiss();
      }
    });
  }

  finishDrag() {
    const completed = this.dragging;
    this.win.clearTimeout(this.dragTimer);
    this.win.clearTimeout(this.dragFinishTimer);
    this.dragTimer = 0;
    this.dragFinishTimer = 0;
    this.dragging = false;
    this.internalFileDrag = false;
    for (const drawer of this.drawers.values()) drawer.endDrag(completed);
  }

  scheduleScan() {
    if (this.frame || !this.active) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      if (this.active) this.scan();
    });
  }

  scan() {
    const roots = new Set(this.media.matches ? this.doc.querySelectorAll(ELIGIBLE) : []);
    for (const [root, drawer] of this.drawers) {
      if (!roots.has(root) || drawer.nav !== root.querySelector(":scope > .nn-navigation-pane") ||
        !root.querySelector(":scope > .nn-list-pane") || !root.contains(drawer.button)) {
        drawer.destroy();
        this.drawers.delete(root);
      }
    }
    for (const root of roots) {
      const nav = root.querySelector(":scope > .nn-navigation-pane");
      if (nav && root.querySelector(":scope > .nn-list-pane") && !this.drawers.has(root)) {
        this.drawers.set(root, new Drawer(this, root, nav));
      }
    }
  }

  stop() {
    this.active = false;
    this.observer?.disconnect();
    this.win.clearTimeout(this.dragTimer);
    this.win.clearTimeout(this.dragFinishTimer);
    this.dragTimer = 0;
    this.dragFinishTimer = 0;
    this.win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const drawer of this.drawers.values()) drawer.destroy();
    this.drawers.clear();
    this.dragging = false;
    this.internalFileDrag = false;
  }

  destroy() {
    this.destroyed = true;
    this.stop();
    this.media.removeEventListener("change", this.mediaListener);
  }
}

class Drawer {
  constructor(manager, root, nav) {
    this.manager = manager;
    this.plugin = manager.plugin;
    this.win = root.ownerDocument.defaultView;
    this.root = root;
    this.nav = nav;
    this.disposers = [];
    this.openTimer = 0;
    this.closeTimer = 0;
    this.selectionFrame = 0;
    this.selectionTimer = 0;
    this.pendingFolderPath = null;
    this.open = false;
    this.hovered = false;
    this.focused = false;
    this.keyboard = false;
    this.dragInside = false;
    this.contextOpen = false;
    this.destroyed = false;
    this.originalInert = nav.inert;
    this.originalVars = new Map();
    this.button = root.createEl("button", { cls: "flra-nn-trigger", attr: { type: "button", "aria-expanded": "false" } });
    this.button.createSpan({ cls: "flra-nn-trigger-icon", attr: { "aria-hidden": "true" } });
    root.classList.add("flra-nn-drawer");
    nav.inert = true;

    const owns = (node) => node?.nodeType != null && (this.nav.contains(node) || this.button.contains(node));
    for (const target of [this.button, nav]) {
      this.listen(target, "pointerenter", () => {
        if (manager.dragging) return;
        this.hovered = true;
        this.update();
      });
      this.listen(target, "pointerleave", (event) => {
        if (manager.dragging) return;
        this.hovered = owns(event.relatedTarget);
        this.update();
      });
      this.listen(target, "focusin", () => {
        this.focused = this.keyboard || this.button.matches(":focus-visible");
        this.update();
      });
      this.listen(target, "focusout", () => this.win.queueMicrotask(() => {
        if (this.destroyed) return;
        this.focused = this.keyboard && owns(root.ownerDocument.activeElement);
        this.update();
      }));
    }
    this.listen(root, "keydown", (event) => {
      if (event.key === "Tab") {
        this.keyboard = true;
        this.focused = owns(root.ownerDocument.activeElement);
        this.update();
      }
    });
    this.listen(root, "pointerdown", () => { this.keyboard = false; this.focused = false; });
    this.listen(this.button, "click", () => {
      this.clearTimers();
      this.focused = this.button.matches(":focus-visible");
      this.setOpen(true);
    });
    this.listen(nav, "click", (event) => this.onFolderClick(event), true);
    this.observer = new this.win.MutationObserver(() => {
      const active = nav.matches(".nn-context-menu-active") || !!nav.querySelector(".nn-context-menu-active");
      if (this.contextOpen !== active) {
        this.contextOpen = active;
        this.update();
      }
      this.scheduleSelectionCheck();
    });
    this.observer.observe(nav, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
    this.applySettings();
  }

  listen(target, type, handler, options = false) {
    target.addEventListener(type, handler, options);
    this.disposers.push(() => target.removeEventListener(type, handler, options));
  }

  onFolderClick(event) {
    this.clearSelectionCheck();
    if (!this.open || this.manager.dragging || event.button !== 0 ||
      event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = element(event.target);
    // Chevron toggles and inline editing do not select a file list.
    if (!target || target.closest(".nn-navitem-chevron, input, textarea, select, button, a, [contenteditable]")) return;
    const row = target.closest('.nn-folder[data-path][data-clickable="folder"]');
    if (!row || !this.nav.contains(row)) return;
    this.pendingFolderPath = row.getAttribute("data-path");
    // Expire an unhandled click rather than closing on an unrelated later selection.
    this.selectionTimer = this.win.setTimeout(() => this.clearSelectionCheck(), 1000);
    this.scheduleSelectionCheck();
  }

  scheduleSelectionCheck() {
    if (this.destroyed || this.pendingFolderPath === null || this.selectionFrame) return;
    this.selectionFrame = this.win.requestAnimationFrame(() => {
      this.selectionFrame = 0;
      if (this.destroyed || !this.open || this.manager.dragging || this.contextOpen) return;
      // Check committed selection on the next frame, after React has handled click
      // and rendered navigation and the corresponding file list together.
      const selected = Array.from(this.nav.querySelectorAll(".nn-folder.nn-selected[data-path]"))
        .find((row) => row.getAttribute("data-path") === this.pendingFolderPath);
      if (selected) this.dismiss();
    });
  }

  clearSelectionCheck() {
    this.win.cancelAnimationFrame(this.selectionFrame);
    this.win.clearTimeout(this.selectionTimer);
    this.selectionFrame = 0;
    this.selectionTimer = 0;
    this.pendingFolderPath = null;
  }

  applySettings() {
    for (const option of NAVIGATOR_OPTIONS) {
      if (!option.css) continue;
      const name = `--flra-nn-${option.css}`;
      if (!this.originalVars.has(name)) this.originalVars.set(name, [this.root.style.getPropertyValue(name), this.root.style.getPropertyPriority(name)]);
      const value = this.plugin.settings[option.key];
      this.root.style.setProperty(name, `${option.type === "toggle" ? Number(value) : value}${option.unit || ""}`);
    }
    this.button.setAttribute("aria-label", this.plugin.t("nn.trigger"));
    if (!this.plugin.settings.nnDragEnabled) this.endDrag();
  }

  clearTimers() {
    this.win.clearTimeout(this.openTimer);
    this.win.clearTimeout(this.closeTimer);
    this.openTimer = 0;
    this.closeTimer = 0;
  }

  setOpen(open) {
    if (this.destroyed) return;
    if (!open) this.clearSelectionCheck();
    this.open = open;
    this.root.classList.toggle("flra-nn-open", open);
    this.button.setAttribute("aria-expanded", String(open));
    this.nav.inert = open ? this.originalInert : true;
  }

  update() {
    if (this.destroyed) return;
    const wanted = this.hovered || this.focused || this.contextOpen || this.dragInside;
    if (wanted) {
      this.win.clearTimeout(this.closeTimer);
      this.closeTimer = 0;
      if (this.open || this.openTimer) return;
      const delay = this.contextOpen || this.focused ? 0 : this.dragInside ? this.plugin.settings.nnDragDelay : this.plugin.settings.nnOpenDelay;
      this.openTimer = this.win.setTimeout(() => {
        this.openTimer = 0;
        this.setOpen(true);
      }, delay);
    } else {
      this.win.clearTimeout(this.openTimer);
      this.openTimer = 0;
      if (!this.open || this.closeTimer) return;
      this.closeTimer = this.win.setTimeout(() => {
        this.closeTimer = 0;
        this.setOpen(false);
      }, this.plugin.settings.nnCloseDelay);
    }
  }

  beginDrag() {
    this.clearSelectionCheck();
    this.hovered = false;
    this.focused = false;
    this.dragInside = false;
    this.clearTimers();
    this.update();
  }

  dragOver(event) {
    const inside = containsPoint(this.button, event) || (this.open && containsPoint(this.nav, event));
    this.dragInside = inside;
    this.root.classList.toggle("flra-nn-drag-over", inside);
    this.update();
  }

  endDrag(completed = false) {
    this.dragInside = false;
    this.root.classList.remove("flra-nn-drag-over");
    if (completed) {
      this.dismiss();
      return;
    }
    this.update();
  }

  dismiss() {
    this.clearSelectionCheck();
    this.hovered = false;
    this.focused = false;
    this.keyboard = false;
    this.dragInside = false;
    this.clearTimers();
    if (this.nav.contains(this.root.ownerDocument.activeElement)) this.button.focus({ preventScroll: true });
    // Focus restoration must not schedule another opening after Escape.
    this.clearTimers();
    this.focused = false;
    if (!this.contextOpen) this.setOpen(false);
  }

  destroy() {
    this.destroyed = true;
    this.clearSelectionCheck();
    this.clearTimers();
    this.observer.disconnect();
    for (const dispose of this.disposers) dispose();
    this.button.remove();
    this.nav.inert = this.originalInert;
    this.root.classList.remove("flra-nn-drawer", "flra-nn-open", "flra-nn-drag-over");
    for (const [name, [value, priority]] of this.originalVars) {
      if (value) this.root.style.setProperty(name, value, priority);
      else this.root.style.removeProperty(name);
    }
  }
}

module.exports = { NotebookNavigatorDrawer };
