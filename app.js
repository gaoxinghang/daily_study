import {
  storage_key,
  create_state,
  create_task,
  task_remaining,
  get_stats,
  settle,
  select_task,
  toggle_timer,
  is_valid_state,
} from "./model.js";

const find = (selector) => document.querySelector(selector);
const find_all = (selector) => document.querySelectorAll(selector);
let storage_available = true;
let load_warning = "";
let state = load_state();
let current_filter = "all";
let toast_timeout;
let last_signature = "";
const category_classes = {
  阅读: "",
  语言: "language",
  编程: "coding",
  课程: "course",
};

function load_state() {
  /** 从当前浏览器恢复每日计划，不覆盖损坏的原始备份。 */
  try {
    const raw = localStorage.getItem(storage_key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (is_valid_state(parsed)) return parsed;
      localStorage.setItem(`${storage_key}.backup`, raw);
      load_warning = "旧数据无法读取，已保留备份并建立新计划。";
    }
  } catch {
    storage_available = false;
    load_warning = "无法读取本地记录，本次进度可能无法保存。";
  }
  return create_state();
}

function save_state() {
  /** 持久化计时状态；存储不可用时明确提示而不阻断学习。 */
  try {
    localStorage.setItem(storage_key, JSON.stringify(state));
    storage_available = true;
  } catch {
    if (storage_available) {
      show_toast("浏览器无法保存进度，请勿关闭或刷新页面。");
    }
    storage_available = false;
  }
  find("#save-status").textContent = storage_available
    ? "● 进度自动保存在此浏览器"
    : "⚠ 当前进度无法保存，请勿刷新";
}

function show_toast(message) {
  /** 展示不打断计时的操作反馈。 */
  clearTimeout(toast_timeout);
  find("#toast").textContent = message;
  find("#toast").classList.add("show");
  toast_timeout = setTimeout(() => {
    find("#toast").classList.remove("show");
  }, 4200);
}

function escape_html(value) {
  /** 对用户输入转义，避免任务内容被当作 HTML 执行。 */
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function icon(name) {
  /** 生成引用本地 SVG 图标库的装饰图标。 */
  return `<svg class="icon" aria-hidden="true">
    <use href="#icon-${name}"/></svg>`;
}

function time_label(milliseconds) {
  /** 将剩余毫秒向上取整显示，避免提前出现零秒。 */
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function task_markup(task) {
  /** 生成可选择但不可手动勾选完成的任务卡片。 */
  const selected = state.selected_id === task.id;
  const running = task.deadline !== null;
  const status = task.completed ? "已完成" : running ? "专注中" : "";
  const classes = ["task-card"];
  if (selected) classes.push("selected");
  if (task.completed) classes.push("completed");
  const category_class = category_classes[task.category] || "";
  const id = escape_html(task.id);
  const title = escape_html(task.title);
  const action = running ? "暂停" : "开始";
  return `
    <article class="${classes.join(" ")}" data-id="${id}">
      <button class="task-select" data-action="select"
        aria-label="选择任务：${title}" aria-pressed="${selected}">
        <span class="task-indicator">
          ${task.completed ? icon("check") : ""}
        </span>
        <span class="task-info">
          <span class="task-title" title="${title}">${title}</span>
          <span class="task-meta">
            <span class="category-tag ${category_class}">
              ${escape_html(task.category)}
            </span>
            <span class="task-duration">${icon("clock")}
              ${task.duration_ms / 60_000} 分钟
            </span>
            <span class="task-note" title="${escape_html(task.note)}">
              ${escape_html(task.note)}
            </span>
          </span>
        </span>
      </button>
      <div class="task-actions">
        <span class="task-state">${status}</span>
        ${
          task.completed
            ? ""
            : `
          <button class="icon-button" data-action="toggle"
            aria-label="${action}任务：${title}">
            ${icon(running ? "pause" : "play")}
          </button>`
        }
        <button class="icon-button delete-task" data-action="delete"
          aria-label="删除任务：${title}">${icon("trash")}</button>
      </div>
      <div class="task-inline-progress"><span></span></div>
    </article>`;
}

function render_tasks() {
  /** 根据筛选条件渲染任务列表，并避免每秒重建焦点元素。 */
  const tasks = state.tasks.filter((task) => {
    if (current_filter === "pending") return !task.completed;
    if (current_filter === "done") return task.completed;
    return true;
  });
  if (tasks.length) {
    find("#task-list").innerHTML = tasks.map(task_markup).join("");
  } else {
    const empty_titles = {
      all: "给今天安排一个小目标吧",
      pending: "今天的计划，都完成啦",
      done: "每一份专注，都值得等待",
    };
    const title = !state.tasks.length
      ? empty_titles.all
      : empty_titles[current_filter];
    const detail =
      current_filter === "done" && state.tasks.length
        ? "倒计时结束后，完成的任务会出现在这里。"
        : "可以添加新的学习任务，也可以留一点时间休息。";
    find("#task-list").innerHTML = `
      <div class="empty-state">${icon("leaf")}
        <strong>${title}</strong><p>${detail}</p>
      </div>`;
  }
  find("#list-count").textContent = state.tasks.length;
  find_all(".filter").forEach((button) => {
    const active = button.dataset.filter === current_filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function render_timer(now) {
  /** 更新计时环、控制按钮和页面标题。 */
  const task = state.tasks.find((item) => item.id === state.selected_id);
  const remaining = task ? task_remaining(task, now) : 0;
  const running = Boolean(task && task.deadline !== null);
  const completed = Boolean(task && task.completed);
  const started = task && remaining < task.duration_ms;
  const progress = task ? 1 - remaining / task.duration_ms : 0;
  find("#timer-task-name").textContent = task
    ? task.title
    : "先添加一个学习任务";
  find("#timer-category").textContent = task
    ? `${task.category} · 计划专注 ${task.duration_ms / 60_000} 分钟`
    : "给自己一段专注的时间";
  find("#time-display").textContent = time_label(remaining);
  find("#ring-progress").style.strokeDashoffset = 678.584 * (1 - progress);
  find("#timer-status").textContent = completed
    ? "今日已完成"
    : running
      ? "正在专注"
      : started
        ? "已暂停"
        : "准备开始";
  find("#timer-status").classList.toggle("running", running);
  find("#timer-caption").textContent = completed
    ? "又向理想的自己，近了一点"
    : running
      ? "每一秒，都在积累"
      : started
        ? "歇一会儿，随时可以继续"
        : "放下杂念，从此刻开始";
  find("#start-label").textContent = completed
    ? "今日已完成"
    : running
      ? "暂停计时"
      : started
        ? "继续专注"
        : "开始专注";
  find("#start-button use").setAttribute(
    "href",
    `#icon-${completed ? "check" : running ? "pause" : "play"}`,
  );
  find("#start-button").disabled = !task || completed;
  find("#reset-button").disabled = !task || completed || !started;
  document.title = running
    ? `${time_label(remaining)} · ${task.title} | 拾光`
    : "拾光 · 每日学习";
}

function render() {
  /** 刷新概览及计时，任务结构变化时才更新任务列表。 */
  const now = Date.now();
  const result = settle(state, now);
  if (result.changed) {
    save_state();
    if (result.new_day) {
      show_toast("新的一天，新的开始。昨日记录已归档。");
    } else if (result.completed_ids.length) {
      show_toast("专注完成！今天又积累了一点成长。");
    }
  }
  const signature = JSON.stringify(state) + current_filter;
  if (signature !== last_signature) {
    render_tasks();
    last_signature = signature;
    if (find("#history-dialog").open) render_history();
  }
  const stats = get_stats(state.tasks, now);
  const percentage = stats.total
    ? Math.round((stats.completed / stats.total) * 100)
    : 0;
  find("#total-count").textContent = stats.total;
  find("#focus-minutes").textContent = Math.floor(stats.focus_ms / 60_000);
  find("#completion-percent").textContent = percentage;
  find("#completion-text").textContent =
    `${stats.completed} / ${stats.total} 项已完成`;
  find("#completion-bar").style.width = `${percentage}%`;
  find("#date-label").textContent = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(now);
  find_all(".task-card").forEach((card) => {
    const task = state.tasks.find((item) => item.id === card.dataset.id);
    const progress = 1 - task_remaining(task, now) / task.duration_ms;
    card.querySelector(".task-inline-progress span").style.width =
      `${progress * 100}%`;
  });
  render_timer(now);
}

function render_history() {
  /** 显示当前日期及最近归档日期的学习汇总。 */
  const rows = [
    { day: state.day, ...get_stats(state.tasks) },
    ...state.history.slice().reverse(),
  ];
  find("#history-list").innerHTML = rows
    .map(
      (row, index) => `
    <div class="history-row">
      <div><strong>${escape_html(row.day)}${index === 0 ? " · 今天" : ""}
        </strong><span>${row.completed} / ${row.total} 项完成</span></div>
      <p>累计专注 ${Math.floor(row.focus_ms / 60_000)} 分钟</p>
      <div class="progress-track"><span style="width:
        ${row.total ? (row.completed / row.total) * 100 : 0}%"></span></div>
    </div>`,
    )
    .join("");
}

function open_task_dialog() {
  /** 打开添加任务表单，并恢复默认时长。 */
  find("#task-form").reset();
  update_presets();
  find("#task-name").setCustomValidity("");
  find("#task-dialog").showModal();
  find("#task-name").focus();
}

function update_presets() {
  /** 同步常用时长按钮的选择状态。 */
  find_all("[data-minutes]").forEach((button) => {
    const active = button.dataset.minutes === find("#task-duration").value;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

find_all(".add-trigger").forEach((button) => {
  button.addEventListener("click", open_task_dialog);
});

find_all(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

find_all(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    current_filter = button.dataset.filter;
    render();
  });
});

find_all("[data-minutes]").forEach((button) => {
  button.addEventListener("click", () => {
    find("#task-duration").value = button.dataset.minutes;
    update_presets();
  });
});

find("#task-duration").addEventListener("input", update_presets);
find("#task-name").addEventListener("input", () => {
  find("#task-name").setCustomValidity("");
});

find("#task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  render();
  const title = find("#task-name").value.trim();
  if (!title) {
    find("#task-name").setCustomValidity("请写下一个学习目标。");
    find("#task-name").reportValidity();
    return;
  }
  const minutes = Number(find("#task-duration").value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) return;
  const task = create_task(
    title,
    find("#task-category").value,
    minutes,
    find("#task-note").value.trim(),
  );
  state.tasks.push(task);
  if (!state.selected_id) state.selected_id = task.id;
  current_filter = "all";
  save_state();
  render();
  find("#task-dialog").close();
  show_toast("新目标已加入计划，准备好就开始吧。");
});

find("#task-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.closest(".task-card").dataset.id;
  render();
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const action = button.dataset.action;
  if (action === "delete") {
    const confirmed = confirm(
      `删除「${task.title}」？\n该任务及今日计时将移出每日计划。`,
    );
    if (!confirmed) return;
    state.tasks = state.tasks.filter((item) => item.id !== id);
    if (state.selected_id === id) {
      state.selected_id =
        state.tasks.find((item) => !item.completed)?.id ||
        state.tasks[0]?.id ||
        null;
    }
    show_toast("任务已移出每日计划。");
  } else {
    const paused = select_task(state, id);
    if (action === "toggle") toggle_timer(state);
    if (paused) show_toast("上一个任务已暂停，进度为你保留。");
  }
  save_state();
  render();
  if (action !== "delete" && matchMedia("(max-width: 760px)").matches) {
    const reduced_motion = matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    find(".timer-panel").scrollIntoView({
      behavior: reduced_motion ? "instant" : "smooth",
      block: "start",
    });
  }
});

find("#start-button").addEventListener("click", () => {
  toggle_timer(state);
  save_state();
  render();
});

find("#reset-button").addEventListener("click", () => {
  render();
  const task = state.tasks.find((item) => item.id === state.selected_id);
  if (!task || task.completed) return;
  if (!confirm("重新计时会清除这个任务今天的计时进度，确定继续吗？")) {
    return;
  }
  task.deadline = null;
  task.remaining_ms = task.duration_ms;
  save_state();
  render();
  show_toast("已重置，准备好后可以重新开始。");
});

find("#history-button").addEventListener("click", () => {
  render();
  render_history();
  find("#history-dialog").showModal();
});

window.addEventListener("storage", (event) => {
  if (event.key !== storage_key || !event.newValue) return;
  try {
    const updated_state = JSON.parse(event.newValue);
    if (is_valid_state(updated_state)) {
      state = updated_state;
      render();
    }
  } catch {
    show_toast("另一个页面的数据无法读取，当前进度保持不变。");
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render();
});

render();
save_state();
if (load_warning) show_toast(load_warning);
setInterval(render, 250);
