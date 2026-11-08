import {
  create_state,
  create_task,
  task_remaining,
  get_stats,
  settle,
  select_task,
  toggle_timer,
  update_task,
  reset_task,
  apply_task_order,
} from "./model.js";

import { create_cloud } from "./cloud.js";
import { create_nebula } from "./nebula.js";
const find = (selector) => document.querySelector(selector);
const find_all = (selector) => document.querySelectorAll(selector);

let account_ready = false;
let state = create_state();
let prefs = { theme: "dark", sound: true };
let current_filter = "all";
let toast_timeout;
let last_signature = "";
let confirm_callback = null;
let current_view = location.hash === "#history" ? "history" : "today";
let trigger_completion_burst = null;
let task_drag = null;
let drag_frame = 0;
let drag_scroll_frame = 0;

const category_classes = {
  阅读: "",
  语言: "language",
  编程: "coding",
  课程: "course",
  其他: "other",
};

function save_prefs() {
  /** 将提示音偏好随学习数据一起保存到账号。 */
  save_state();
}

function apply_prefs() {
  /** 固定使用曜石黑，并兼容旧账号的主题字段与提示音偏好。 */
  prefs.theme = "dark";
  document.documentElement.dataset.theme = "dark";
  const sound_icon = find("#sound-icon");
  if (sound_icon) {
    sound_icon.setAttribute(
      "href",
      prefs.sound ? "#icon-bell" : "#icon-bell-off",
    );
  }
  const sound_button = find("#sound-button");
  if (sound_button) {
    sound_button.title = `完成提示音：${prefs.sound ? "已开启" : "已静音"}`;
    sound_button.setAttribute("aria-pressed", String(prefs.sound));
  }
}

function play_completion_chime() {
  /** 使用原生 Web Audio 合成温润的完成提示和弦（无外部音频依赖）。 */
  if (!prefs.sound) return;
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start_time = ctx.currentTime + index * 0.12;
      gain.gain.setValueAtTime(0.0001, start_time);
      gain.gain.exponentialRampToValueAtTime(0.08, start_time + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start_time + 1.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start_time);
      osc.stop(start_time + 1.3);
    });
    setTimeout(() => ctx.close().catch(() => {}), 2000);
  } catch {
    // 浏览器音频策略受限时静默降级
  }
}

function save_state() {
  /** 将当前账号的学习数据加入串行云端保存队列。 */
  if (account_ready) cloud.schedule_save({ state, prefs });
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

function ask_confirm(title, message, on_accept) {
  /** 使用自定义确认对话框替代原生阻塞弹窗，忽略重复请求。 */
  const dialog = find("#confirm-dialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    if (confirm(`${title}\n${message}`)) on_accept();
    return;
  }
  if (dialog.open) return;
  find("#confirm-title").textContent = title;
  find("#confirm-message").textContent = message;
  confirm_callback = on_accept;
  dialog.showModal();
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

function duration_summary(task, now) {
  /** 生成任务卡片上的时长与剩余进度文本。 */
  const total_minutes = task.duration_ms / 60_000;
  const remaining = task_remaining(task, now);
  if (task.completed) {
    return `${total_minutes} 分钟 · 已完成`;
  }
  if (task.deadline !== null || remaining < task.duration_ms) {
    return `${total_minutes} 分钟 · 剩余 ${time_label(remaining)}`;
  }
  return `${total_minutes} 分钟`;
}

function task_markup(task, now) {
  /** 生成可选择、可编辑但不可手动勾选完成的任务卡片。 */
  const selected = state.selected_id === task.id;
  const running = task.deadline !== null;
  const remaining = task_remaining(task, now);
  const started = !task.completed && remaining < task.duration_ms;
  const status = task.completed
    ? "已完成"
    : running
      ? "专注中"
      : started
        ? "已暂停"
        : "";
  const classes = ["task-card", "spotlight-card"];
  if (selected) classes.push("selected");
  if (running) classes.push("running");
  if (task.completed) classes.push("completed");
  const category_class = category_classes[task.category] ?? "other";
  const id = escape_html(task.id);
  const title = escape_html(task.title);
  const action = running ? "暂停" : started ? "继续" : "开始";
  const sortable = state.tasks.length > 1;
  const drag_handle = sortable
    ? `<button class="drag-handle" type="button"
        aria-label="拖动调整「${title}」的顺序，或按上下方向键移动"
        title="拖动排序，或按 ↑ ↓ 调整顺序">${icon("grip")}</button>`
    : "";

  return `
    <article class="${classes.join(" ")}" data-id="${id}">
      ${drag_handle}
      <button class="task-select" type="button" data-action="select"
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
            <span class="task-duration">
              ${icon("clock")}
              <span data-role="duration-text">${duration_summary(task, now)}</span>
            </span>
            ${
              task.note
                ? `<span class="task-note" title="${escape_html(task.note)}">
                    ${escape_html(task.note)}
                  </span>`
                : ""
            }
          </span>
        </span>
      </button>
      <div class="task-actions">
        <span class="task-state">${status}</span>
        ${
          task.completed
            ? ""
            : `
          <button class="icon-button toggle-task" type="button" data-action="toggle"
            aria-label="${action}任务：${title}" title="${action}专注">
            ${icon(running ? "pause" : "play")}
          </button>`
        }
        <button class="icon-button edit-task" type="button" data-action="edit"
          aria-label="编辑任务：${title}" title="编辑任务">${icon("edit")}</button>
        <button class="icon-button delete-task" type="button" data-action="delete"
          aria-label="删除任务：${title}" title="删除任务">${icon("trash")}</button>
      </div>
      <div class="task-inline-progress"><span></span></div>
    </article>`;
}

function is_task_visible(task) {
  /** 判断任务是否符合当前筛选条件。 */
  if (current_filter === "pending") return !task.completed;
  if (current_filter === "done") return task.completed;
  return true;
}


function render_tasks(now = Date.now()) {
  /** 根据筛选条件渲染任务列表，并避免每秒重建焦点元素。 */
  abort_task_drag();
  const total_count = state.tasks.length;
  const done_count = state.tasks.filter((task) => task.completed).length;
  const pending_count = total_count - done_count;

  const count_all = find("#filter-count-all");
  const count_pending = find("#filter-count-pending");
  const count_done = find("#filter-count-done");
  if (count_all) count_all.textContent = total_count;
  if (count_pending) count_pending.textContent = pending_count;
  if (count_done) count_done.textContent = done_count;

  const tasks = state.tasks.filter(is_task_visible);
  if (tasks.length) {
    find("#task-list").innerHTML = tasks
      .map((task) => task_markup(task, now))
      .join("");
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
  /** 更新计时环、指针圆点、控制按钮和页面标题。 */
  const task = state.tasks.find((item) => item.id === state.selected_id);
  const remaining = task ? task_remaining(task, now) : 0;
  const running = Boolean(task && task.deadline !== null);
  const completed = Boolean(task && task.completed);
  const started = Boolean(task && remaining < task.duration_ms);
  const progress = task ? 1 - remaining / task.duration_ms : 0;

  document.body.classList.toggle("is-focusing", running);

  find("#timer-task-name").textContent = task
    ? task.title
    : "先添加一个学习任务";
  find("#timer-category").textContent = task
    ? `${task.category} · 计划专注 ${task.duration_ms / 60_000} 分钟`
    : "给自己一段专注的时间";
  const note_el = find("#timer-task-note");
  if (note_el) {
    note_el.textContent = task && task.note ? `“${task.note}”` : "";
  }
  find("#time-display").textContent = time_label(remaining);
  find("#ring-progress").style.strokeDashoffset = 678.584 * (1 - progress);
  const dot_group = find("#ring-dot-group");
  if (dot_group) {
    dot_group.style.transform = `rotate(${progress * 360}deg)`;
  }
  find("#timer-dial").classList.toggle("running", running);
  find("#timer-dial").classList.toggle("completed", completed);
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
      ? "每一秒，都在发光"
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
  /** 刷新概览及计时，任务结构变化时才重建任务列表 DOM。 */
  if (!account_ready) return;
  const now = Date.now();
  const result = settle(state, now);
  if (result.changed) {
    save_state();
    if (result.new_day) {
      show_toast("新的一天，新的开始。昨日记录已归档。");
    } else if (result.completed_ids.length) {
      play_completion_chime();
      if (typeof trigger_completion_burst === "function") {
        trigger_completion_burst();
      }
      show_toast("专注完成！今天又积累了一点成长。");
    }
  }
  const signature = JSON.stringify(state) + current_filter;
  if (signature !== last_signature) {
    render_tasks(now);
    last_signature = signature;
  }
  if (current_view === "history") {
    render_history(now);
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
    if (!task) return;
    const progress = 1 - task_remaining(task, now) / task.duration_ms;
    card.querySelector(".task-inline-progress span").style.width =
      `${progress * 100}%`;
    const duration_el = card.querySelector('[data-role="duration-text"]');
    if (duration_el) {
      duration_el.textContent = duration_summary(task, now);
    }
  });
  render_timer(now);
}

function switch_view(view_name) {
  /** 切换今日计划与学习足迹页面视图。 */
  current_view = view_name === "history" ? "history" : "today";
  const is_history = current_view === "history";

  const view_today = find("#view-today");
  const view_history = find("#view-history");
  if (view_today) {
    view_today.classList.toggle("active", !is_history);
    view_today.hidden = is_history;
  }
  if (view_history) {
    view_history.classList.toggle("active", is_history);
    view_history.hidden = !is_history;
  }

  const breadcrumb = find("#breadcrumb-current");
  if (breadcrumb) {
    breadcrumb.textContent = is_history ? "学习足迹" : "今日计划";
  }

  const nav_today = find("#nav-today");
  const nav_history = find("#nav-history");
  if (nav_today) {
    nav_today.classList.toggle("active", !is_history);
    nav_today.setAttribute("aria-current", !is_history ? "page" : "false");
  }
  if (nav_history) {
    nav_history.classList.toggle("active", is_history);
    nav_history.setAttribute("aria-current", is_history ? "page" : "false");
  }

  if (window.location.hash !== (is_history ? "#history" : "#today")) {
    history.replaceState(null, "", is_history ? "#history" : "#today");
  }

  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function render_history(now = Date.now()) {
  /** 显示当前日期及最近归档日期的学习汇总与统计概览。 */
  const rows = [
    { day: state.day, is_today: true, ...get_stats(state.tasks, now) },
    ...state.history
      .filter((entry) => entry.day !== state.day)
      .slice()
      .reverse(),
  ];
  const total_days = rows.filter(
    (row) => row.focus_ms >= 60_000 || row.completed > 0,
  ).length;
  const total_minutes = rows.reduce(
    (sum, row) => sum + Math.floor(row.focus_ms / 60_000),
    0,
  );
  const total_completed = rows.reduce((sum, row) => sum + row.completed, 0);

  const days_el = find("#history-total-days");
  const min_el = find("#history-total-minutes");
  const comp_el = find("#history-total-completed");
  const count_el = find("#history-entry-count");

  if (days_el) days_el.textContent = total_days;
  if (min_el) min_el.textContent = total_minutes;
  if (comp_el) comp_el.textContent = total_completed;
  if (count_el) count_el.textContent = rows.length;

  const list_el = find("#history-list");
  if (!list_el) return;

  if (!rows.length) {
    list_el.innerHTML = `
      <div class="empty-state">${icon("leaf")}
        <strong>还没有学习记录</strong>
        <p>开始今天的第一个任务吧，积累的专注时间会在这里为你保留。</p>
      </div>`;
    return;
  }

  list_el.innerHTML = rows
    .map((row) => {
      const is_today = Boolean(row.is_today);
      const pct = row.total
        ? Math.round((row.completed / row.total) * 100)
        : 0;
      const minutes = Math.floor(row.focus_ms / 60_000);
      const day_label = escape_html(row.day);
      return `
        <article class="history-row spotlight-card ${is_today ? "today" : ""}">
          <div class="history-date-cell">
            <strong>${day_label}</strong>
            ${is_today ? '<span class="history-badge">今天</span>' : ""}
          </div>
          <div class="history-stats-cell">
            ${icon("check")}
            <span>${row.completed} / ${row.total} 项完成</span>
          </div>
          <div class="history-focus-cell">
            ${icon("clock")}
            <span>专注 ${minutes} 分钟</span>
          </div>
          <div class="history-progress-cell">
            <div class="progress-track" title="完成率 ${pct}%">
              <span style="width: ${pct}%"></span>
            </div>
            <span class="history-progress-pct">${pct}%</span>
          </div>
        </article>`;
    })
    .join("");
}

function open_task_dialog(edit_task_item = null) {
  /** 打开新建或编辑任务弹窗。 */
  find("#task-form").reset();
  const is_edit = Boolean(edit_task_item && edit_task_item.id);
  find("#task-edit-id").value = is_edit ? edit_task_item.id : "";
  find("#dialog-eyebrow").textContent = is_edit
    ? "ADJUST YOUR GOAL"
    : "A NEW LITTLE GOAL";
  find("#dialog-title").textContent = is_edit
    ? "调整学习任务"
    : "给成长留一点时间";
  find("#dialog-description").textContent = is_edit
    ? "修改任务内容或时长，今天已经投入的专注时间会为你保留。"
    : "从一个小目标开始，让今天有所收获。";
  find("#submit-label").textContent = is_edit ? "保存修改" : "加入我的计划";
  find("#submit-icon")?.setAttribute(
    "href",
    is_edit ? "#icon-check" : "#icon-plus",
  );

  const duration_input = find("#task-duration");
  const hint_el = find("#form-hint");
  const preset_buttons = find_all("[data-minutes]");

  if (is_edit) {
    find("#task-name").value = edit_task_item.title;
    find("#task-category").value = edit_task_item.category;
    duration_input.value = String(
      edit_task_item.duration_ms / 60_000,
    );
    find("#task-note").value = edit_task_item.note || "";

    if (edit_task_item.completed) {
      duration_input.disabled = true;
      preset_buttons.forEach((b) => (b.disabled = true));
      if (hint_el) {
        hint_el.textContent = "今日已完成的任务不可修改时长，仅可调整名称、分类或提示。";
      }
    } else {
      duration_input.disabled = false;
      const elapsed_ms = Math.max(0, edit_task_item.duration_ms - task_remaining(edit_task_item));
      const min_allowed = Math.ceil((elapsed_ms + 60_000) / 60_000);
      duration_input.min = String(min_allowed);
      preset_buttons.forEach((b) => {
        b.disabled = Number(b.dataset.minutes) < min_allowed;
      });
      if (hint_el) {
        hint_el.textContent = elapsed_ms > 0
          ? `今天已专注约 ${Math.floor(elapsed_ms / 60_000)} 分钟，新时长至少需为 ${min_allowed} 分钟。`
          : "任务会加入每日计划，第二天自动开始新一轮。";
      }
    }
  } else {
    duration_input.disabled = false;
    duration_input.min = "1";
    preset_buttons.forEach((b) => (b.disabled = false));
    if (hint_el) {
      hint_el.textContent = "任务会加入每日计划，第二天自动开始新一轮。";
    }
  }

  update_presets();
  find("#task-name").setCustomValidity("");
  duration_input.setCustomValidity("");
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

function toggle_zen_mode() {
  /** 切换沉浸专注模式。 */
  if (current_view !== "today") {
    switch_view("today");
  }
  const active = document.body.classList.toggle("zen-mode");
  const zen_icon = find("#zen-icon");
  if (zen_icon) {
    zen_icon.setAttribute("href", active ? "#icon-shrink" : "#icon-expand");
  }
  const zen_button = find("#zen-button");
  if (zen_button) {
    zen_button.setAttribute("aria-pressed", String(active));
    zen_button.title = active
      ? "退出沉浸模式 (快捷键 F 或 Esc)"
      : "沉浸专注模式 (快捷键 F)";
  }
}

/* =========================================================
 * 界面事件绑定
 * ========================================================= */
find_all(".add-trigger").forEach((button) => {
  button.addEventListener("click", () => open_task_dialog());
});

find_all(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

find_all("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const clicked_inside =
      rect.top <= event.clientY &&
      event.clientY <= rect.bottom &&
      rect.left <= event.clientX &&
      event.clientX <= rect.right;
    if (!clicked_inside) dialog.close();
  });
});

find("#confirm-dialog")?.addEventListener("close", () => {
  // 通过 Esc、背景或关闭按钮退出时，丢弃失效的确认回调。
  confirm_callback = null;
});

find("#confirm-cancel")?.addEventListener("click", () => {
  confirm_callback = null;
  find("#confirm-dialog").close();
});

find("#confirm-accept")?.addEventListener("click", () => {
  const callback = confirm_callback;
  confirm_callback = null;
  find("#confirm-dialog").close();
  if (typeof callback === "function") callback();
});

find("#sound-button")?.addEventListener("click", () => {
  prefs.sound = !prefs.sound;
  apply_prefs();
  save_prefs();
  show_toast(
    prefs.sound ? "已开启倒计时完成提示音。" : "已关闭倒计时完成提示音。",
  );
});

find("#zen-button")?.addEventListener("click", toggle_zen_mode);

find_all(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    current_filter = button.dataset.filter;
    render();
  });
});

find_all("[data-minutes]").forEach((button) => {
  button.addEventListener("click", () => {
    find("#task-duration").value = button.dataset.minutes;
    find("#task-duration").setCustomValidity("");
    update_presets();
  });
});

find("#task-duration").addEventListener("input", () => {
  find("#task-duration").setCustomValidity("");
  update_presets();
});

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
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) {
    find("#task-duration").setCustomValidity("请输入 1 到 480 之间的整数分钟。");
    find("#task-duration").reportValidity();
    return;
  }
  const edit_id = find("#task-edit-id").value;
  if (edit_id) {
    const target = state.tasks.find((item) => item.id === edit_id);
    if (!target) return;
    if (state.tasks.length > 300) {
      show_toast("每日学习任务最多支持 300 项。");
      return;
    }
    const elapsed_ms = Math.max(0, target.duration_ms - task_remaining(target));
    if (target.completed && minutes * 60_000 !== target.duration_ms) {
      show_toast("已完成的任务不能修改时长，可以只改标题或提示。");
      return;
    }
    const min_allowed_minutes = Math.ceil((elapsed_ms + 60_000) / 60_000);
    if (!target.completed && minutes < min_allowed_minutes) {
      const elapsed_display = Math.floor(elapsed_ms / 60_000);
      show_toast(
        `今天已专注 ${elapsed_display} 分钟，新时长至少需设置为 ${min_allowed_minutes} 分钟。若想缩短，可先重置计时。`,
      );
      return;
    }
    const updated = update_task(state, edit_id, {
      title,
      category: find("#task-category").value,
      minutes,
      note: find("#task-note").value.trim(),
    });
    if (!updated) {
      show_toast("保存失败，请检查任务时长后重试。");
      return;
    }
    save_state();
    render();
    find("#task-dialog").close();
    show_toast("任务修改已保存。");
    return;
  }

  if (state.tasks.length >= 300) {
    show_toast("每日学习任务已达 300 项上限，请先清理部分旧任务。");
    return;
  }

  const task = create_task(
    title,
    find("#task-category").value,
    minutes,
    find("#task-note").value.trim(),
  );
  state.tasks.push(task);
  const current_selected = state.tasks.find(
    (item) => item.id === state.selected_id,
  );
  const any_running = state.tasks.some((item) => item.deadline !== null);
  if (!current_selected || (current_selected.completed && !any_running)) {
    state.selected_id = task.id;
  }
  current_filter = "all";
  save_state();
  render();
  find("#task-dialog").close();
  show_toast("新目标已加入计划，准备好就开始吧。");
});

function prefers_reduced_motion() {
  /** 读取系统动态效果偏好；即使减少动画也保留拖拽能力。 */
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}


function task_cards() {
  /** 返回当前列表中的任务卡片，按界面顺序排列。 */
  return [...find_all("#task-list .task-card")];
}


function task_card_by_id(id) {
  /** 按标识查找任务卡片，避免把标识拼进选择器。 */
  return task_cards().find((card) => card.dataset.id === id) || null;
}


function persist_task_order(ids) {
  /** 合并可见顺序并保存；顺序未变化时不产生多余同步。 */
  const ordered = apply_task_order(state.tasks, ids);
  if (!ordered) return false;
  const changed = ordered.some((task, index) => {
    return task.id !== state.tasks[index].id;
  });
  if (!changed) return false;
  state.tasks = ordered;
  save_state();
  return true;
}


function focus_task_handle(id) {
  /** 排序后把焦点还给同一任务的手柄，便于连续调整。 */
  const handle = task_card_by_id(id)?.querySelector(".drag-handle");
  handle?.focus({ preventScroll: true });
}


function cleanup_task_drag() {
  /** 移除浮层与占位槽，恢复卡片样式并解除全局监听。 */
  if (!task_drag) return;
  const { card, handle, pointer_id, placeholder } = task_drag;
  window.removeEventListener("pointermove", move_task_drag, false);
  window.removeEventListener("pointerup", end_task_drag);
  window.removeEventListener("pointercancel", cancel_task_drag);
  window.removeEventListener("blur", cancel_task_drag);
  cancelAnimationFrame(drag_frame);
  cancelAnimationFrame(drag_scroll_frame);
  drag_frame = 0;
  drag_scroll_frame = 0;
  if (placeholder) {
    if (placeholder.parentNode) placeholder.replaceWith(card);
    else card.remove();
  }
  card.classList.remove("is-floating");
  card.style.width = "";
  card.style.height = "";
  card.style.left = "";
  card.style.top = "";
  card.style.transform = "";
  find("#task-list")?.classList.remove("is-reordering");
  document.body.classList.remove("task-dragging");
  try {
    if (handle.hasPointerCapture?.(pointer_id)) {
      handle.releasePointerCapture(pointer_id);
    }
  } catch {
    // 指针已释放时忽略，拖拽状态仍会清理。
  }
  task_drag = null;
}


function abort_task_drag() {
  /** 列表即将重建时放弃进行中的拖拽，避免操作失效节点。 */
  if (task_drag) cleanup_task_drag();
}


function dragged_task_order() {
  /** 按占位槽位置生成提交顺序，忽略正在悬浮的卡片。 */
  const drag = task_drag;
  const ids = [];
  for (const element of find("#task-list").children) {
    if (element === drag.placeholder) ids.push(drag.id);
    else if (element !== drag.card && element.dataset?.id) {
      ids.push(element.dataset.id);
    }
  }
  return ids;
}


function animate_reflow(cards, positions) {
  /** 用 FLIP 让让位的卡片平滑滑向新位置。 */
  if (prefers_reduced_motion()) return;
  for (const card of cards) {
    const delta = positions.get(card) - card.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) continue;
    card.animate(
      [
        { transform: `translateY(${delta}px)` },
        { transform: "translateY(0)" },
      ],
      { duration: 220, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" },
    );
  }
}


function refresh_drag_targets() {
  /** 用不受动画影响的布局坐标缓存卡片中线，减少布局读取。 */
  const drag = task_drag;
  if (!drag) return;
  const origins = new Map();
  drag.targets = task_cards()
    .filter((card) => card !== drag.card)
    .map((card) => {
      const parent = card.offsetParent || document.body;
      if (!origins.has(parent)) {
        origins.set(parent, parent.getBoundingClientRect().top + scrollY);
      }
      return {
        card,
        middle: origins.get(parent) + card.offsetTop + card.offsetHeight / 2,
      };
    });
}


function place_drag_placeholder(y) {
  /** 根据指针位置移动占位槽，其他卡片平滑让位。 */
  const drag = task_drag;
  const list = find("#task-list");
  const pointer = y + scrollY;
  const entry = drag.targets.find((item) => pointer < item.middle);
  const next = entry ? entry.card : null;
  const settled = next
    ? drag.placeholder.nextElementSibling === next
    : list.lastElementChild === drag.placeholder;
  if (settled) return;
  const cards = drag.targets.map((entry) => entry.card);
  const positions = new Map(
    cards.map((card) => [card, card.getBoundingClientRect().top]),
  );
  if (next) list.insertBefore(drag.placeholder, next);
  else list.append(drag.placeholder);
  animate_reflow(cards, positions);
  refresh_drag_targets();
}


function render_task_drag(now) {
  /** 平滑跟随指针，并给出轻微抬升与倾斜反馈。 */
  if (!task_drag?.active || task_drag.dropping) {
    drag_frame = 0;
    return;
  }
  const drag = task_drag;
  const delta = drag.frame_time
    ? Math.min((now - drag.frame_time) / 16.67, 3)
    : 1;
  drag.frame_time = now;
  const ease = drag.reduce ? 1 : 1 - Math.pow(0.66, delta);
  drag.render_x += (drag.target_x - drag.render_x) * ease;
  drag.render_y += (drag.target_y - drag.render_y) * ease;
  drag.lift = drag.reduce ? 1 : Math.min(1, drag.lift + delta * 0.14);
  drag.velocity_x *= Math.pow(0.84, delta);
  const tilt = drag.reduce
    ? 0
    : Math.max(-3.5, Math.min(3.5, drag.velocity_x * 0.35)) * drag.lift;
  const scale = drag.reduce ? 1 : 1 + drag.lift * 0.028;
  drag.card.style.transform =
    `translate3d(${drag.render_x}px, ${drag.render_y}px, 0)` +
    ` rotate(${tilt}deg) scale(${scale})`;
  drag_frame = requestAnimationFrame(render_task_drag);
}


function start_task_drag() {
  /** 抬起卡片、留下占位槽，并启动跟随与自动滚动循环。 */
  const drag = task_drag;
  const card = drag.card;
  const rect = card.getBoundingClientRect();
  drag.home_rect = rect;
  drag.offset_x = drag.start_x - rect.left;
  drag.offset_y = drag.start_y - rect.top;
  drag.render_x = 0;
  drag.render_y = 0;
  drag.target_x = 0;
  drag.target_y = 0;
  drag.lift = 0;
  drag.frame_time = 0;
  drag.reduce = prefers_reduced_motion();
  drag.placeholder = document.createElement("div");
  drag.placeholder.className = "drag-placeholder";
  drag.placeholder.style.height = `${rect.height}px`;
  drag.placeholder.setAttribute("aria-hidden", "true");
  card.before(drag.placeholder);
  card.style.width = `${rect.width}px`;
  card.style.height = `${rect.height}px`;
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.top}px`;
  card.classList.add("is-floating");
  // 面板的 backdrop-filter 会成为 fixed 的包含块，移到 body 才能跟随视口。
  document.body.append(card);
  refresh_drag_targets();
  find("#task-list").classList.add("is-reordering");
  document.body.classList.add("task-dragging");
  drag.active = true;
  drag_frame = requestAnimationFrame(render_task_drag);
  drag_scroll_frame = requestAnimationFrame(auto_scroll_task_drag);
}


function move_task_drag(event) {
  /** 更新浮层目标位置并让占位槽跟随指针。 */
  if (!task_drag || event.pointerId !== task_drag.pointer_id) return;
  if (event.pointerType === "mouse" && event.buttons === 0) {
    cancel_task_drag(event);
    return;
  }
  const drag = task_drag;
  if (!drag.active) {
    const distance = Math.hypot(
      event.clientX - drag.start_x,
      event.clientY - drag.start_y,
    );
    if (distance < 5) return;
    start_task_drag();
  }
  if (drag.dropping) return;
  event.preventDefault();
  drag.velocity_x = event.clientX - drag.last_x;
  drag.last_x = event.clientX;
  drag.last_y = event.clientY;
  drag.target_x = event.clientX - drag.offset_x - drag.home_rect.left;
  drag.target_y = event.clientY - drag.offset_y - drag.home_rect.top;
  place_drag_placeholder(event.clientY);
}


function auto_scroll_task_drag() {
  /** 指针停在视口边缘时持续滚动，并同步占位位置。 */
  if (!task_drag?.active || task_drag.dropping) return;
  const y = task_drag.last_y;
  const edge = 96;
  let delta = 0;
  if (y < edge) delta = -Math.ceil((edge - y) / 5);
  else if (y > innerHeight - edge) {
    delta = Math.ceil((y - innerHeight + edge) / 5);
  }
  if (delta) {
    window.scrollBy(0, delta);
    place_drag_placeholder(y);
  }
  drag_scroll_frame = requestAnimationFrame(auto_scroll_task_drag);
}


async function end_task_drag(event) {
  /** 让浮层落回占位槽，再提交新顺序。 */
  if (!task_drag || event.pointerId !== task_drag.pointer_id) return;
  const drag = task_drag;
  if (!drag.active) {
    cleanup_task_drag();
    return;
  }
  if (drag.dropping) return;
  drag.dropping = true;
  const ids = dragged_task_order();
  const slot = drag.placeholder.getBoundingClientRect();
  const dx = slot.left - drag.home_rect.left;
  const dy = slot.top - drag.home_rect.top;
  if (!drag.reduce) {
    const animation = drag.card.animate([
      { transform: getComputedStyle(drag.card).transform },
      { transform: `translate3d(${dx}px, ${dy}px, 0) rotate(0deg) scale(1)` },
    ], {
      duration: 200,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "forwards",
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 500));
    await Promise.race([animation.finished.catch(() => {}), timeout]);
  }
  if (task_drag !== drag) return;
  cleanup_task_drag();
  const changed = persist_task_order(ids);
  if (!changed) last_signature = "";
  render();
  if (changed) show_toast("任务顺序已更新。");
}


function cancel_task_drag(event) {
  /** 指针被系统取消或窗口失焦时放弃本次排序。 */
  if (!task_drag) return;
  const pointer_id = event?.pointerId;
  if (pointer_id !== undefined && pointer_id !== task_drag.pointer_id) return;
  if (task_drag.dropping) return;
  cleanup_task_drag();
  last_signature = "";
  render();
}


function reorder_by_keyboard(id, offset) {
  /** 用方向键在当前可见顺序内上移或下移一位。 */
  const ids = state.tasks.filter(is_task_visible).map((task) => task.id);
  const index = ids.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  if (!persist_task_order(ids)) return;
  render();
  focus_task_handle(id);
  show_toast(offset < 0 ? "已上移一位。" : "已下移一位。");
}


find("#task-list").addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".drag-handle");
  const card = handle?.closest(".task-card");
  if (!card) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (task_drag) return;
  try {
    handle.setPointerCapture?.(event.pointerId);
  } catch {
    // 合成事件或已结束的指针无法捕获，仍可继续拖动。
  }
  task_drag = {
    id: card.dataset.id,
    card,
    handle,
    pointer_id: event.pointerId,
    start_x: event.clientX,
    start_y: event.clientY,
    last_x: event.clientX,
    last_y: event.clientY,
    velocity_x: 0,
    active: false,
    dropping: false,
  };
  window.addEventListener("pointermove", move_task_drag, { passive: false });
  window.addEventListener("pointerup", end_task_drag);
  window.addEventListener("pointercancel", cancel_task_drag);
  window.addEventListener("blur", cancel_task_drag);
});


window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !task_drag?.active) return;
  event.preventDefault();
  cancel_task_drag();
});


find("#task-list").addEventListener("keydown", (event) => {
  const handle = event.target.closest(".drag-handle");
  if (!handle) return;
  const offset = event.key === "ArrowUp" ? -1
    : event.key === "ArrowDown" ? 1 : 0;
  if (!offset) return;
  event.preventDefault();
  reorder_by_keyboard(handle.closest(".task-card").dataset.id, offset);
});


find("#task-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.closest(".task-card").dataset.id;
  render();
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const action = button.dataset.action;

  if (action === "edit") {
    open_task_dialog(task);
    return;
  }

  if (action === "delete") {
    ask_confirm(
      `删除「${task.title}」？`,
      "该任务及今日已计入的专注时长将移出每日计划。",
      () => {
        state.tasks = state.tasks.filter((item) => item.id !== id);
        if (state.selected_id === id) {
          state.selected_id =
            state.tasks.find((item) => !item.completed)?.id ||
            state.tasks[0]?.id ||
            null;
        }
        save_state();
        render();
        show_toast("任务已移出每日计划。");
      },
    );
    return;
  }

  const paused = select_task(state, id);
  if (action === "toggle") toggle_timer(state);
  if (paused) show_toast("上一个任务已暂停，进度为你保留。");
  save_state();
  render();
  if (matchMedia("(max-width: 760px)").matches) {
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
  ask_confirm(
    `重置「${task.title}」？`,
    "重新计时会清除这个任务今天的专注进度，确定继续吗？",
    () => {
      // 确认期间任务可能已经到点，重新结算后再判断。
      if (!reset_task(state, task.id)) {
        render();
        show_toast("这个任务今天已经完成，无需重置。");
        return;
      }
      save_state();
      render();
      show_toast("已重置，准备好后可以重新开始。");
    },
  );
});

find("#nav-today")?.addEventListener("click", (event) => {
  event.preventDefault();
  switch_view("today");
});

find("#nav-history")?.addEventListener("click", (event) => {
  event.preventDefault();
  switch_view("history");
});

find("#history-back-button")?.addEventListener("click", () => {
  switch_view("today");
});

window.addEventListener("hashchange", () => {
  const target_view = location.hash === "#history" ? "history" : "today";
  if (target_view !== current_view) switch_view(target_view);
});

document.addEventListener("keydown", (event) => {
  if (
    !account_ready ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    find("dialog[open]")
  ) {
    return;
  }
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  if (event.code === "Space" && tag !== "BUTTON" && tag !== "A") {
    event.preventDefault();
    toggle_timer(state);
    save_state();
    render();
  } else if (event.key === "n" || event.key === "N") {
    event.preventDefault();
    open_task_dialog();
  } else if (event.key === "f" || event.key === "F") {
    event.preventDefault();
    toggle_zen_mode();
  } else if (
    event.key === "Escape" &&
    document.body.classList.contains("zen-mode")
  ) {
    toggle_zen_mode();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render();
});

const nebula = create_nebula();
trigger_completion_burst = () => nebula.burst();

const cloud = create_cloud({
  on_load(workspace) {
    state = workspace.state;
    prefs = workspace.prefs;
    account_ready = true;
    last_signature = "";
    apply_prefs();
    switch_view(current_view);
  },
  on_lock() {
    account_ready = false;
    document.body.classList.remove("is-focusing");
    state = create_state();
    prefs = { theme: "dark", sound: true };
    last_signature = "";
    current_filter = "all";
    find("#task-list").replaceChildren();
    find("#history-list").replaceChildren();
    find("#task-form").reset();
    find("#profile-form").reset();
    find("#timer-task-name").textContent = "";
    find("#timer-task-note").textContent = "";
    find("#sidebar-name").textContent = "学习者";
    find("#sidebar-bio").textContent = "";
    find("#account-name").textContent = "个人资料";
    document.title = "拾光 · 每日学习";
    apply_prefs();
  },
  notify: show_toast,
});

await cloud.start();
setInterval(render, 250);
