const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("notes fade in immediately after navigation without body checks or an exit delay", async () => {
  let now = 0;
  let requestedFrames = 0, metadataReads = 0, layoutReads = 0;
  const timeouts = new Map();
  let nextTimer = 0;
  const sandbox = {
    module: { exports: {} }, require: () => ({}),
    performance: { now: () => now },
    MutationObserver: class { observe() {} disconnect() {} },
    window: {
      setTimeout: (callback, duration) => { timeouts.set(++nextTimer, { callback, duration }); return nextTimer; },
      clearTimeout: (id) => timeouts.delete(id),
      requestAnimationFrame: () => { requestedFrames++; },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../note-transitions.js"), "utf8"), sandbox);
  const { NoteTransitions } = sandbox.module.exports;
  const manager = new NoteTransitions({
    app: { workspace: {}, metadataCache: { getFileCache: () => { metadataReads++; return { frontmatter: { cssclasses: ["unapplied-style"] } }; } } },
    settings: { noteAnimEnabled: true, noteExitDuration: 100, noteDuration: 360, noteDistance: 20 },
  });
  manager.motion = { matches: false };
  const animations = [];
  const animate = (target) => (keyframes, options) => {
    let finish;
    const animation = { target, keyframes, options, currentTime: 0, finished: new Promise((resolve) => { finish = resolve; }), cancel() {}, finish: () => finish() };
    animations.push(animation);
    return animation;
  };
  const clip = { classList: { add() {}, remove() {} } };
  const incoming = {
    parentElement: clip,
    getClientRects: () => { layoutReads++; return []; },
    getBoundingClientRect: () => { layoutReads++; return { width: 0, height: 0 }; },
    animate: animate("new"),
  };
  let pending = true;
  let resolveNavigation;
  const navigation = new Promise((resolve) => { resolveNavigation = resolve; });
  const target = {
    containerEl: { classList: { remove: () => { pending = false; } } },
    loadIfDeferred: () => navigation,
    view: { file: { path: "B.md" }, getViewType: () => "markdown", getMode: () => "source", containerEl: clip,
      contentEl: { querySelector: () => incoming } },
  };
  const group = { children: [target], currentTab: 0 };
  let removed = false;
  const transition = {
    group, target, path: "B.md", modeChange: false, floating: false,
    direction: { x: 1, y: 0 }, holds: 0, animations: [], clips: new Set(),
    surface: { animate: animate("old") }, layer: { remove: () => { removed = true; } },
  };
  manager.transitions.set(group, transition);
  manager.startExit(transition);
  const [oldMovement, oldFade] = animations;
  assert.equal(oldMovement.keyframes[0].transform, "translate(0, 0)");
  assert.equal(oldMovement.keyframes[1].transform, "translate(-20px, 0px)");
  assert.equal(oldFade.options.direction, "reverse", "note opacity must use the exit direction of the chosen easing");
  assert.equal(oldFade.keyframes.at(-1).opacity, 1, "reverse playback must begin with the unchanged old picture");
  assert.equal(oldFade.keyframes[0].opacity, 0, "reverse playback must end fully transparent without a holding pose");
  assert.equal(oldFade.options.duration, 100);
  manager.ready(transition);
  await new Promise(setImmediate);
  assert.equal(pending, true, "navigation still owns the renderer until its call completes");
  assert.equal(animations.filter((item) => item.target === "new").length, 0);
  now = 30;
  resolveNavigation();
  await new Promise(setImmediate);
  assert.equal(pending, false, "the new page must be released as soon as navigation completes");
  assert.equal(metadataReads, 0, "cssclasses must not gate the incoming page");
  assert.equal(layoutReads, 0, "incoming layout must not be polled for stability");
  assert.equal(requestedFrames, 0, "there must be no extra render-frame wait");
  assert.equal(animations.filter((item) => item.target === "old").length, 2, "the old page must never start a second exit");
  const [newMovement, newFade] = animations.filter((item) => item.target === "new");
  assert.equal(newMovement.keyframes[0].transform, "translate(20px, 0px)");
  assert.equal(newMovement.options.duration, 360, "incoming movement must use its own configured duration");
  assert.equal(newMovement.currentTime, 0, "incoming movement must retain its complete trajectory");
  assert.equal(newFade.currentTime, 0, "incoming content must begin transparent rather than skipping ahead");
  assert.equal(newFade.options.delay ?? 0, 0, "fade-in must overlap the ongoing exit instead of waiting for it");
  assert.equal(newFade.options.duration, 360);
  assert.equal(removed, false);
  now = 100;
  oldFade.finish();
  await new Promise(setImmediate);
  assert.equal(removed, true, "release the snapshot as soon as its continuous fade completes");
});
