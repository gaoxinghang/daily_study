import test from "node:test";
import assert from "node:assert/strict";
import {
  create_state,
  create_task,
  day_key,
  task_remaining,
  get_stats,
  settle,
  select_task,
  toggle_timer,
  is_valid_state,
} from "../model.js";

const start = new Date(2026, 5, 12, 10, 0, 0).getTime();

test("开始、暂停、恢复，只有计时结束后才完成", () => {
  const state = create_state(start);
  const task = state.tasks[0];
  toggle_timer(state, start);
  assert.equal(task.deadline, start + task.duration_ms);
  assert.equal(task.completed, false);
  toggle_timer(state, start + 10_000);
  assert.equal(task.deadline, null);
  assert.equal(task.remaining_ms, task.duration_ms - 10_000);
  assert.equal(task_remaining(task, start + 90_000), task.remaining_ms);
  toggle_timer(state, start + 100_000);
  const deadline = task.deadline;
  settle(state, deadline - 1);
  assert.equal(task.completed, false);
  settle(state, deadline);
  assert.equal(task.completed, true);
  assert.equal(task.remaining_ms, 0);
  assert.equal(task.deadline, null);
  toggle_timer(state, deadline + 1000);
  assert.equal(task.deadline, null);
});

test("刷新后的后台计时仍按照真实截止时间完成", () => {
  const state = create_state(start);
  toggle_timer(state, start);
  const restored = JSON.parse(JSON.stringify(state));
  assert.ok(is_valid_state(restored));
  settle(restored, start + 26 * 60_000);
  assert.equal(restored.tasks[0].completed, true);
  assert.equal(get_stats(restored.tasks).focus_ms, 25 * 60_000);
});

test("切换任务暂停旧任务，最多只有一个运行计时器", () => {
  const state = create_state(start);
  toggle_timer(state, start);
  assert.equal(select_task(state, state.tasks[1].id, start + 5000), true);
  assert.equal(state.tasks[0].remaining_ms, 25 * 60_000 - 5000);
  toggle_timer(state, start + 6000);
  assert.equal(state.tasks.filter((task) => task.deadline !== null).length, 1);
  assert.ok(is_valid_state(state));
});

test("跨日只计入午夜前的时间，第二天计划重新开始", () => {
  const night = new Date(2026, 5, 12, 23, 59, 0).getTime();
  const morning = new Date(2026, 5, 13, 8, 0, 0).getTime();
  const state = create_state(night);
  toggle_timer(state, night);
  settle(state, morning);
  assert.equal(state.day, day_key(morning));
  assert.equal(state.history[0].focus_ms, 60_000);
  assert.equal(state.history[0].completed, 0);
  assert.equal(state.tasks[0].remaining_ms, 25 * 60_000);
  assert.equal(state.tasks[0].deadline, null);
  assert.equal(state.tasks[0].completed, false);
  assert.ok(is_valid_state(state));
});

test("午夜前已经结束的计时正确归入昨天", () => {
  const night = new Date(2026, 5, 12, 23, 30, 0).getTime();
  const morning = new Date(2026, 5, 13, 8, 0, 0).getTime();
  const state = create_state(night);
  toggle_timer(state, night);
  settle(state, morning);
  assert.equal(state.history[0].completed, 1);
  assert.equal(state.history[0].focus_ms, 25 * 60_000);
  assert.equal(state.tasks[0].completed, false);
});

test("损坏缓存及非法并发计时不会通过校验", () => {
  assert.equal(is_valid_state(null), false);
  const state = create_state(start);
  state.tasks[0].remaining_ms = -1;
  assert.equal(is_valid_state(state), false);
  const duplicated = create_state(start);
  duplicated.tasks.push(duplicated.tasks[0]);
  assert.equal(is_valid_state(duplicated), false);
  const invalid_history = create_state(start);
  invalid_history.history.push({ day: "nope" });
  assert.equal(is_valid_state(invalid_history), false);
});

test("支持空计划与自定义时长任务", () => {
  const state = create_state(start);
  state.tasks = [];
  state.selected_id = null;
  assert.ok(is_valid_state(state));
  toggle_timer(state, start);
  assert.deepEqual(get_stats(state.tasks), {
    total: 0,
    completed: 0,
    focus_ms: 0,
  });
  const task = create_task("测试", "其他", 1);
  state.tasks.push(task);
  state.selected_id = task.id;
  toggle_timer(state, start);
  settle(state, start + 60_000);
  assert.equal(task.completed, true);
});
