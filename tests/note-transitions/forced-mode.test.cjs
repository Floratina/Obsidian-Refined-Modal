const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("forced reading mode is selected before loading and its corrections remain one navigation", async () => {
  const timers = new Map();
  let timerId = 0;
  const sandbox = {
    module: { exports: {} }, require: () => ({ TFolder: class {} }), performance,
    document: { querySelector: () => null },
    window: {
      setTimeout: (callback, duration) => { timers.set(++timerId, { callback, duration }); return timerId; },
      clearTimeout: (id) => timers.delete(id),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../note-transitions.js"), "utf8"), sandbox);
  const { NoteTransitions } = sandbox.module.exports;
  const a = { path: "A.md", basename: "A", extension: "md" };
  const b = { path: "B.md", basename: "B", extension: "md" };
  const workspace = {};
  const force = { settings: { folders: [], files: [], ignoreOpenFiles: false, ignoreForceViewAll: false } };
  const manager = new NoteTransitions({
    app: {
      workspace, plugins: { getPlugin: (id) => id === "obsidian-view-mode-by-frontmatter" ? force : null },
      vault: { getAbstractFileByPath: (name) => name === b.path ? b : a,
        getConfig: (name) => name === "defaultViewMode" ? "source" : true },
      metadataCache: { getFileCache: () => ({ frontmatter: { obsidianUIMode: "preview", obsidianEditingMode: "live" } }) },
    },
    settings: {}, register() {},
  });
  manager.enabled = () => true;
  manager.supported = () => true;
  const host = { getBoundingClientRect: () => ({ width: 800, height: 600 }), classList: { remove() {} } };
  const viewport = { getClientRects: () => [] };
  const received = [];
  const leaf = {
    workspace, containerEl: { classList: { add() {}, remove() {} } },
    view: { file: a, mode: "source", getViewType: () => "markdown", getMode() { return this.mode; },
      contentEl: { querySelector: () => viewport } },
    setViewState(state) {
      received.push(state);
      this.view.file = state.state.file === b.path ? b : a;
      this.view.mode = state.state.mode ?? this.view.mode;
      return Promise.resolve("host-result");
    },
  };
  const group = { children: [leaf], currentTab: 0, containerEl: host };
  leaf.parent = group;
  manager.intent = { kind: "list", path: b.path, directions: new Map([[leaf, 1]]), time: performance.now() };
  manager.wrap(leaf, "setViewState", (target, args) => manager.beforeViewState(target, args), true);
  const entries = [], continuations = [];
  manager.play = (transition) => { transition.playing = true; entries.push(transition); };
  manager.animateIncoming = (transition) => continuations.push(transition);

  const request = { type: "markdown", active: true, state: { file: b.path, scroll: 7 } };
  assert.equal(await leaf.setViewState(request), "host-result", "the wrapper must preserve the host's return value");
  await new Promise(setImmediate);
  assert.equal(received[0].state.mode, "preview", "the first host request must already select the final reading mode");
  assert.equal(received[0].state.source, false);
  assert.equal(received[0].state.scroll, 7, "other navigation state must be preserved");
  assert.equal(received[0].active, true);
  assert.equal(request.state.mode, undefined, "do not mutate the caller's request");
  assert.equal(entries.length, 1);
  const navigation = entries[0];
  assert.equal(navigation.modeChange, false);
  assert.equal(navigation.direction.y, 1, "initial mode selection must preserve the file-list direction");

  // Simulate a companion correcting an intermediate renderer during entry.
  leaf.view.mode = "source";
  await leaf.setViewState({ type: "markdown", state: { file: b.path, mode: "preview" } });
  await new Promise(setImmediate);
  assert.equal(manager.transitions.get(group), navigation, "correction must not replace the navigation with a mode animation");
  assert.equal(entries.length, 1);
  assert.equal(continuations.at(-1), navigation, "the replacement renderer must continue the existing animation");
  assert.equal([...timers.values()].some((timer) => timer.duration === 100), false);

  // A delayed correction must not start a second animation after cleanup either.
  manager.cancel(navigation);
  leaf.view.mode = "source";
  await leaf.setViewState({ type: "markdown", state: { file: b.path, mode: "preview" } });
  await new Promise(setImmediate);
  assert.equal(manager.transitions.size, 0);
  assert.equal(entries.length, 1);

  // Pointer input in the note/header ends navigation ownership before a manual toggle.
  manager.cancelIn(host);
  await leaf.setViewState({ type: "markdown", state: { file: b.path, mode: "source" } });
  await new Promise(setImmediate);
  assert.equal(manager.transitions.get(group).modeChange, true, "a user mode toggle must retain its separate animation");
  assert.equal([...timers.values()].some((timer) => timer.duration === 100), true);
  assert.equal(received.at(-1).state.mode, "source", "preselection must not override a same-note manual toggle");
});
