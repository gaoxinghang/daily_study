import test from "node:test";
import assert from "node:assert/strict";
import {
  create_state,
  create_task,
  create_task_id,
  day_key,
  task_remaining,
  get_stats,
  settle,
  select_task,
  toggle_timer,
  update_task,
  reset_task,
  is_valid_state,
} from "../model.js";

const start = new Date(2026, 5, 12, 10, 0, 0).getTime();

test("局域网 HTTP 无 randomUUID 时仍能生成唯一任务标识", () => {
  const crypto_api = {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  };
  const uuid_pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/;
  const ids = new Set();
  for (let index = 0; index < 100; index += 1) {
    const id = create_task_id(crypto_api);
    assert.equal(id.length, 36);
    assert.match(id, uuid_pattern);
    ids.add(id);
  }
  assert.equal(ids.size, 100);
});

test("极端环境下无 crypto 对象时降级生成合法 UUID", () => {
  const uuid_pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/;
  const id = create_task_id(null);
  assert.equal(id.length, 36);
  assert.match(id, uuid_pattern);
});

test("HTTPS 或 localhost 优先使用原生 randomUUID", () => {
  const id = create_task_id({ randomUUID: () => "native-uuid" });
  assert.equal(id, "native-uuid");
});

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

test("切换任务时若原任务已到点，应直接结算完成而非误判为暂停", () => {
  const state = create_state(start);
  toggle_timer(state, start);
  const finished_time = start + 25 * 60_000;
  const had_running = select_task(state, state.tasks[1].id, finished_time);
  assert.equal(had_running, false);
  assert.equal(state.tasks[0].completed, true);
  assert.equal(state.tasks[0].remaining_ms, 0);
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

test("损坏缓存、非法溢出日期及非法并发计时不会通过校验", () => {
  assert.equal(is_valid_state(null), false);
  const state = create_state(start);
  state.tasks[0].remaining_ms = -1;
  assert.equal(is_valid_state(state), false);
  const rollover_day = create_state(start);
  rollover_day.day = "2026-02-31";
  assert.equal(is_valid_state(rollover_day), false);
  const duplicated = create_state(start);
  duplicated.tasks.push(duplicated.tasks[0]);
  assert.equal(is_valid_state(duplicated), false);
  const invalid_history = create_state(start);
  invalid_history.history.push({ day: "nope" });
  assert.equal(is_valid_state(invalid_history), false);
});

test("编辑任务保留当日已专注时长并保持状态合法", () => {
  const state = create_state(start);
  const task = state.tasks[0];
  toggle_timer(state, start);
  toggle_timer(state, start + 10 * 60_000);
  assert.equal(task.remaining_ms, 15 * 60_000);

  const ok = update_task(
    state,
    task.id,
    { title: "精读专业书籍", category: "课程", minutes: 30, note: "做读书笔记" },
    start + 10 * 60_000,
  );
  assert.equal(ok, true);
  assert.equal(task.title, "精读专业书籍");
  assert.equal(task.category, "课程");
  assert.equal(task.duration_ms, 30 * 60_000);
  assert.equal(task.remaining_ms, 20 * 60_000);
  assert.equal(task.completed, false);
  assert.ok(is_valid_state(state));
});

test("缩短到少于已专注时间会被拒绝，统计与状态保持不变", () => {
  const state = create_state(start);
  const task = state.tasks[0];
  toggle_timer(state, start);
  toggle_timer(state, start + 10 * 60_000);
  const before = get_stats(state.tasks, start + 10 * 60_000).focus_ms;

  assert.equal(
    update_task(state, task.id, { minutes: 5 }, start + 10 * 60_000),
    false,
  );
  assert.equal(task.duration_ms, 25 * 60_000);
  assert.equal(task.completed, false);
  assert.equal(get_stats(state.tasks, start + 10 * 60_000).focus_ms, before);
  assert.ok(is_valid_state(state));
});


test("缩短到刚好等于已专注时间不会自动判定完成", () => {
  const state = create_state(start);
  const task = state.tasks[0];
  toggle_timer(state, start);
  toggle_timer(state, start + 10 * 60_000);
  assert.equal(
    update_task(state, task.id, { minutes: 10 }, start + 10 * 60_000),
    false,
  );
  assert.equal(task.completed, false);
  assert.ok(is_valid_state(state));
  assert.equal(
    update_task(state, task.id, { minutes: 11 }, start + 10 * 60_000),
    true,
  );
  assert.equal(task.remaining_ms, 60_000);
  assert.equal(task.completed, false);
});


test("已完成任务只能改内容，不能改时长", () => {
  const state = create_state(start);
  const task = state.tasks[0];
  toggle_timer(state, start);
  settle(state, start + task.duration_ms);
  assert.equal(task.completed, true);
  const focus_before = get_stats(state.tasks, start).focus_ms;
  const finished_at = start + task.duration_ms;

  assert.equal(update_task(state, task.id, { minutes: 10 }, finished_at), false);
  assert.equal(task.duration_ms, 25 * 60_000);
  assert.equal(get_stats(state.tasks, start).focus_ms, focus_before);
  assert.equal(
    update_task(state, task.id, { title: "改个标题" }, finished_at),
    true,
  );
  assert.equal(task.title, "改个标题");
  assert.equal(task.completed, true);
  assert.ok(is_valid_state(state));
});


test("计时到点后重置会被拒绝，避免写入非法缓存", () => {
  const state = create_state(start);
  const task = state.tasks[0];
  toggle_timer(state, start);
  assert.equal(reset_task(state, task.id, start + 60_000), true);
  assert.equal(task.remaining_ms, task.duration_ms);
  toggle_timer(state, start + 60_000);
  const deadline = task.deadline;
  assert.equal(reset_task(state, task.id, deadline), false);
  assert.equal(task.completed, true);
  assert.equal(task.remaining_ms, 0);
  assert.equal(task.deadline, null);
  assert.ok(is_valid_state(state));
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
