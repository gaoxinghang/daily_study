export const storage_key = "shiguang.daily-study.v1";

export function day_key(now = Date.now()) {
  /** 返回本地时区中的日期标识。 */
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function create_task(title, category, minutes, note = "") {
  /** 创建一个尚未开始的每日学习任务。 */
  const duration_ms = minutes * 60_000;
  return {
    id: crypto.randomUUID(),
    title,
    category,
    note,
    duration_ms,
    remaining_ms: duration_ms,
    deadline: null,
    completed: false,
  };
}

export function create_state(now = Date.now()) {
  /** 创建含可删除的入门计划的本地学习空间。 */
  const tasks = [
    create_task("阅读，让思绪慢下来", "阅读", 25, "读几页书，记一点感悟"),
    create_task("每日英语积累", "语言", 20, "认识新单词，也认识新世界"),
    create_task(
      "写代码，解决一个小问题",
      "编程",
      45,
      "动手实践，让知识真正属于自己",
    ),
  ];
  return {
    version: 1,
    day: day_key(now),
    tasks,
    selected_id: tasks[0].id,
    history: [],
  };
}

export function task_remaining(task, now = Date.now()) {
  /** 返回任务的剩余毫秒数，后台计时同样使用真实时间。 */
  if (task.completed) return 0;
  const remaining =
    task.deadline === null ? task.remaining_ms : task.deadline - now;
  return Math.max(0, Math.min(task.duration_ms, remaining));
}

export function get_stats(tasks, now = Date.now()) {
  /** 汇总完成数及实际已经计入任务的专注时间。 */
  return {
    total: tasks.length,
    completed: tasks.filter((task) => task.completed).length,
    focus_ms: tasks.reduce((sum, task) => {
      return sum + task.duration_ms - task_remaining(task, now);
    }, 0),
  };
}

function complete_due_tasks(state, now) {
  /** 仅在截止时间到达后将任务标记为完成。 */
  const completed_ids = [];
  for (const task of state.tasks) {
    if (task.deadline !== null && task.deadline <= now) {
      task.remaining_ms = 0;
      task.deadline = null;
      task.completed = true;
      completed_ids.push(task.id);
    }
  }
  return completed_ids;
}

export function settle(state, now = Date.now()) {
  /** 结算到期任务；跨天时归档并重新生成每日计划。 */
  const current_day = day_key(now);
  if (current_day === state.day) {
    const completed_ids = complete_due_tasks(state, now);
    return { changed: completed_ids.length > 0, completed_ids };
  }

  const [year, month, day] = state.day.split("-").map(Number);
  const boundary = new Date(year, month - 1, day + 1).getTime();
  const cutoff = Math.min(boundary, now);
  complete_due_tasks(state, cutoff);
  state.history.push({ day: state.day, ...get_stats(state.tasks, cutoff) });
  state.history = state.history.slice(-29);
  for (const task of state.tasks) {
    task.remaining_ms = task.duration_ms;
    task.deadline = null;
    task.completed = false;
  }
  state.day = current_day;
  return { changed: true, new_day: true, completed_ids: [] };
}

export function pause_task(task, now = Date.now()) {
  /** 暂停任务并保存准确的剩余时长。 */
  if (task.deadline === null) return;
  task.remaining_ms = task_remaining(task, now);
  task.deadline = null;
  if (task.remaining_ms === 0) task.completed = true;
}

export function select_task(state, id, now = Date.now()) {
  /** 切换选择，并暂停其他任务，确保同时只专注一项任务。 */
  const target = state.tasks.find((task) => task.id === id);
  if (!target) return false;
  const had_running = state.tasks.some((task) => {
    return task.id !== id && task.deadline !== null;
  });
  state.tasks.forEach((task) => {
    if (task.id !== id) pause_task(task, now);
  });
  state.selected_id = id;
  return had_running;
}

export function toggle_timer(state, now = Date.now()) {
  /** 开始或暂停所选任务；已完成任务不可重复开始。 */
  settle(state, now);
  const task = state.tasks.find((item) => item.id === state.selected_id);
  if (!task || task.completed) return;
  if (task.deadline !== null) {
    pause_task(task, now);
  } else {
    select_task(state, task.id, now);
    task.deadline = now + task.remaining_ms;
  }
}

export function is_valid_state(state) {
  /** 校验浏览器缓存，避免损坏或旧格式数据导致页面崩溃。 */
  if (!state || state.version !== 1 || !Array.isArray(state.tasks)) {
    return false;
  }
  const valid_day = (day) => {
    return (
      typeof day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      Number.isFinite(new Date(`${day}T00:00:00`).getTime())
    );
  };
  if (!valid_day(state.day) || !Array.isArray(state.history)) return false;
  const ids = new Set();
  let running = 0;
  for (const task of state.tasks) {
    if (!task || typeof task.id !== "string" || ids.has(task.id)) {
      return false;
    }
    ids.add(task.id);
    if (
      typeof task.title !== "string" ||
      !task.title.trim() ||
      typeof task.category !== "string" ||
      typeof task.note !== "string" ||
      !Number.isFinite(task.duration_ms) ||
      task.duration_ms < 60_000 ||
      task.duration_ms > 480 * 60_000 ||
      !Number.isFinite(task.remaining_ms) ||
      task.remaining_ms < 0 ||
      task.remaining_ms > task.duration_ms ||
      typeof task.completed !== "boolean"
    )
      return false;
    if (task.deadline !== null) {
      if (!Number.isFinite(task.deadline) || task.completed) return false;
      running += 1;
      if (task.id !== state.selected_id) return false;
    }
    if (task.completed && task.remaining_ms !== 0) return false;
    if (!task.completed && task.remaining_ms === 0) return false;
  }
  if (running > 1) return false;
  if (state.tasks.length > 0 && !ids.has(state.selected_id)) return false;
  return state.history.every((entry) => {
    return (
      entry &&
      valid_day(entry.day) &&
      Number.isInteger(entry.total) &&
      entry.total >= 0 &&
      Number.isInteger(entry.completed) &&
      entry.completed >= 0 &&
      entry.completed <= entry.total &&
      Number.isFinite(entry.focus_ms) &&
      entry.focus_ms >= 0
    );
  });
}
