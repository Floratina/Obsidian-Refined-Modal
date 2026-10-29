const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NotebookNavigatorDrawer } = require("../../notebook-navigator");

test("internal focus changes keep the drawer open; window blur dismisses it", (t) => {
  const win = new EventTarget();
  Object.assign(win, {
    matchMedia: () => new EventTarget(),
    MutationObserver: class { observe() {} disconnect() {} },
    clearTimeout,
    cancelAnimationFrame: clearTimeout,
  });
  const doc = Object.assign(new EventTarget(), { defaultView: win, body: {} });
  const manager = new NotebookNavigatorDrawer({ settings: {} }, doc);
  const drawer = {
    open: true,
    endDrag() {},
    dismiss() { this.open = false; },
    destroy() {},
  };
  manager.drawers.set({}, drawer);
  manager.start();
  t.after(() => manager.destroy());

  // A capture listener on Window also receives blur from focused descendants.
  // Model that event delivery without launching Obsidian or a browser.
  const controlBlur = new Event("blur");
  Object.defineProperty(controlBlur, "target", { value: { ownerDocument: doc } });
  win.dispatchEvent(controlBlur);
  assert.equal(drawer.open, true, "focus moving between controls must not close the card before click");

  win.dispatchEvent(new Event("blur"));
  assert.equal(drawer.open, false, "leaving the window must still dismiss the card");
});
