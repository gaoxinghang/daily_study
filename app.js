import {
  storage_key,
  create_state,
  create_task,
  task_remaining,
  get_stats,
  settle,
  select_task,
  toggle_timer,
  update_task,
  reset_task,
  is_valid_state,
} from "./model.js";

const ui_prefs_key = "shiguang.daily-study.prefs.v1";
const find = (selector) => document.querySelector(selector);
const find_all = (selector) => document.querySelectorAll(selector);

let storage_available = true;
let load_warning = "";
let state = load_state();
let prefs = load_prefs();
let current_filter = "all";
let toast_timeout;
let last_signature = "";
let confirm_callback = null;

const category_classes = {
  阅读: "",
  语言: "language",
  编程: "coding",
  课程: "course",
  其他: "other",
};

function load_prefs() {
  /** 读取界面主题与提示音偏好设置。 */
  try {
    const raw = localStorage.getItem(ui_prefs_key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        theme: parsed.theme === "dark" ? "dark" : "light",
        sound: parsed.sound !== false,
      };
    }
  } catch {
    // 忽略本地偏好读取异常
  }
  return { theme: "light", sound: true };
}

function save_prefs() {
  /** 保存界面主题与提示音偏好设置。 */
  try {
    localStorage.setItem(ui_prefs_key, JSON.stringify(prefs));
  } catch {
    // 忽略偏好写入异常
  }
}

function apply_prefs() {
  /** 同步晨曦/静夜主题与提示音按钮状态。 */
  const is_dark = prefs.theme === "dark";
  document.documentElement.dataset.theme = is_dark ? "dark" : "light";
  const theme_meta = find("#theme-color-meta");
  if (theme_meta) {
    theme_meta.setAttribute("content", is_dark ? "#131b17" : "#f5f6f0");
  }
  const theme_icon = find("#theme-icon");
  if (theme_icon) {
    theme_icon.setAttribute("href", is_dark ? "#icon-sun" : "#icon-moon");
  }
  const theme_label = find("#theme-label");
  if (theme_label) {
    theme_label.textContent = is_dark ? "晨曦纸本" : "静夜书房";
  }
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
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start_time = ctx.currentTime + index * 0.14;
      gain.gain.setValueAtTime(0.0001, start_time);
      gain.gain.exponentialRampToValueAtTime(0.08, start_time + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start_time + 1.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start_time);
      osc.stop(start_time + 1.15);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1800);
  } catch {
    // 浏览器音频策略受限时静默降级
  }
}

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
  const status_box = find("#save-status");
  const status_text = find("#save-status-text");
  if (status_box) {
    status_box.classList.toggle("warning", !storage_available);
  }
  if (status_text) {
    status_text.textContent = storage_available
      ? "进度自动保存在此浏览器"
      : "当前进度无法保存，请勿刷新页面";
  } else if (status_box) {
    status_box.innerHTML = storage_available
      ? "<i></i>进度自动保存在此浏览器"
      : "<i></i>当前进度无法保存，请勿刷新页面";
  }
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
  const classes = ["task-card"];
  if (selected) classes.push("selected");
  if (running) classes.push("running");
  if (task.completed) classes.push("completed");
  const category_class = category_classes[task.category] ?? "other";
  const id = escape_html(task.id);
  const title = escape_html(task.title);
  const action = running ? "暂停" : started ? "继续" : "开始";
  return `
    <article class="${classes.join(" ")}" data-id="${id}">
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

function render_tasks(now = Date.now()) {
  /** 根据筛选条件渲染任务列表，并避免每秒重建焦点元素。 */
  const total_count = state.tasks.length;
  const done_count = state.tasks.filter((task) => task.completed).length;
  const pending_count = total_count - done_count;

  const count_all = find("#filter-count-all");
  const count_pending = find("#filter-count-pending");
  const count_done = find("#filter-count-done");
  if (count_all) count_all.textContent = total_count;
  if (count_pending) count_pending.textContent = pending_count;
  if (count_done) count_done.textContent = done_count;

  const tasks = state.tasks.filter((task) => {
    if (current_filter === "pending") return !task.completed;
    if (current_filter === "done") return task.completed;
    return true;
  });
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
  /** 刷新概览及计时，任务结构变化时才重建任务列表 DOM。 */
  const now = Date.now();
  const result = settle(state, now);
  if (result.changed) {
    save_state();
    if (result.new_day) {
      show_toast("新的一天，新的开始。昨日记录已归档。");
    } else if (result.completed_ids.length) {
      play_completion_chime();
      show_toast("专注完成！今天又积累了一点成长。");
    }
  }
  const signature = JSON.stringify(state) + current_filter;
  if (signature !== last_signature) {
    render_tasks(now);
    last_signature = signature;
  }
  if (find("#history-dialog")?.open) {
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

function render_history(now = Date.now()) {
  /** 显示当前日期及最近归档日期的学习汇总与统计概览。 */
  const rows = [
    { day: state.day, ...get_stats(state.tasks, now) },
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

  const summary_el = find("#history-summary");
  if (summary_el) {
    summary_el.innerHTML = `
      <div class="history-metric">
        <span>专注打卡</span>
        <strong>${total_days} 天</strong>
      </div>
      <div class="history-metric">
        <span>累计专注</span>
        <strong>${total_minutes} 分钟</strong>
      </div>
      <div class="history-metric">
        <span>累计完成</span>
        <strong>${total_completed} 项</strong>
      </div>`;
  }

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

find("#theme-toggle")?.addEventListener("click", () => {
  prefs.theme = prefs.theme === "dark" ? "light" : "dark";
  apply_prefs();
  save_prefs();
  show_toast(
    prefs.theme === "dark"
      ? "已切换至静夜书房模式，愿你今晚静心专注。"
      : "已切换至晨曦纸本模式。",
  );
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

find("#history-button").addEventListener("click", () => {
  render();
  render_history();
  find("#history-dialog").showModal();
});

document.addEventListener("keydown", (event) => {
  if (
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

window.addEventListener("storage", (event) => {
  if (event.key !== storage_key || !event.newValue) return;
  try {
    const updated_state = JSON.parse(event.newValue);
    if (is_valid_state(updated_state)) {
      state = updated_state;
      render();
    } else {
      show_toast("另一个页面的数据格式异常，当前进度保持不变。");
    }
  } catch {
    show_toast("另一个页面的数据无法读取，当前进度保持不变。");
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render();
});

apply_prefs();
render();
save_state();
if (load_warning) show_toast(load_warning);
setInterval(render, 250);
