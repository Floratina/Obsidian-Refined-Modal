const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("mode switching removes the old page before a full 100 ms blank interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sandbox = { module: { exports: {} }, require: () => ({}), performance, window: { setTimeout } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../note-transitions.js"), "utf8"), sandbox);
  const { NoteTransitions } = sandbox.module.exports;
  const manager = new NoteTransitions({ app: { workspace: {} }, settings: { noteModeExitDuration: 170 } });
  const target = { loadIfDeferred: () => Promise.resolve() };
  const group = { children: [target], currentTab: 0 };
  let exitStarted = false;
  let oldPageRemoved = false;
  const transition = {
    group, target, modeChange: true, holds: 0, animations: [],
    layer: { remove: () => { oldPageRemoved = true; } },
    surface: {
      animate: (_frames, options) => {
        exitStarted = true;
        return { finished: new Promise((resolve) => setTimeout(resolve, options.duration)) };
      },
    },
  };
  manager.transitions.set(group, transition);
  const entered = [];
  manager.play = (value) => entered.push(value);

  manager.startExit(transition);
  assert.equal(exitStarted, true, "old content must start fading before waiting for target readiness");
  manager.ready(transition);
  await new Promise(setImmediate);
  t.mock.timers.tick(169);
  await new Promise(setImmediate);
  assert.equal(oldPageRemoved, false, "the configured exit duration must be respected");
  assert.equal(entered.length, 0, "target content must stay hidden during the exit");

  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(oldPageRemoved, true, "the old visual copy must not occupy the blank interval");
  assert.equal(transition.surface, null);
  t.mock.timers.tick(99);
  assert.equal(entered.length, 0, "the entire 100 ms blank interval must elapse after the exit");
  t.mock.timers.tick(1);
  assert.deepEqual(entered, [transition], "the new mode must enter once after the blank interval");
});
