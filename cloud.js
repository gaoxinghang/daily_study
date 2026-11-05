import { storage_key, is_valid_state } from "./model.js";

const find = (selector) => document.querySelector(selector);


export function create_cloud({ on_load, on_lock, notify }) {
  /**
   * 管理账号界面、单会话校验及串行云端保存。
   *
   * Args:
   *   on_load: 接收云端工作区 { state, prefs } 并刷新学习界面的回调。
   *   on_lock: 会话失效时清除页面内账号数据的回调。
   *   notify: 接收字符串并展示非阻塞提示的回调。
   *
   * Returns:
   *   含 start() 和 schedule_save(workspace) 的云端控制器。
   */
  let account = null;
  let session_id = null;
  let revision = 0;
  let pending = null;
  let busy = false;
  let writing = false;
  let saving = null;
  let save_timer;
  let generation = 0;
  let registering = false;

  function status(message, warning = false) {
    /** 显示真实同步状态，断网时不误报为已保存。 */
    find("#save-status-text").textContent = message;
    find("#save-status").classList.toggle("warning", warning);
  }

  function show_profile() {
    /** 使用 textContent 呈现个人资料，避免用户输入成为 HTML。 */
    if (!account) return;
    find("#account-name").textContent = account.display_name;
    find("#sidebar-name").textContent = account.display_name;
    find("#sidebar-bio").textContent = account.bio || "正在成为更好的自己";
    find("#sidebar-avatar").textContent = [...account.display_name][0];
  }

  function lock(message = "") {
    /** 清除当前页面中的账号数据；失效响应不删除其他标签的新 cookie。 */
    generation += 1;
    clearTimeout(save_timer);
    account = null;
    session_id = null;
    pending = null;
    document.querySelectorAll("dialog[open]").forEach((dialog) => {
      dialog.close();
    });
    document.body.classList.remove("zen-mode");
    document.body.dataset.account = "anonymous";
    find("#auth-message").textContent = message;
    find("#auth-password").value = "";
    registering = false;
    find("#auth-title").textContent = "欢迎回到拾光";
    find("#auth-submit").textContent = "登录";
    find("#auth-mode").textContent = "没有账号？去注册";
    find("#register-name-row").hidden = true;
    find("#auth-name").required = false;
    find("#auth-password").autocomplete = "current-password";
    on_lock();
  }

  async function request(path, method = "GET", body, authenticated = true) {
    /** 所有写请求携带来源标识，已登录请求同时绑定页面会话代次。 */
    const headers = { "X-Requested-With": "daily-study" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated && session_id) headers["X-Session-Id"] = session_id;
    const response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "请求失败，请稍后重试。");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function apply_snapshot(result) {
    /** 接收当前账号的云端配置，再交给学习界面渲染。 */
    account = result.user;
    session_id = result.session_id;
    revision = result.revision;
    document.body.dataset.account = "ready";
    show_profile();
    status("个人配置与学习进度已保存到云端");
    on_load(result.workspace);
  }

  async function recover_conflict() {
    /** 冲突时丢弃过期编辑并明确告知，不用旧快照覆盖较新的云端数据。 */
    pending = null;
    const result = await request("/api/session");
    apply_snapshot(result);
    notify("其他页面已更新数据，已加载云端版本；请重新进行刚才的编辑。");
  }

  async function pump() {
    /** 串行保存，使用 revision 避免多标签及重试覆盖更新。 */
    if (busy || !account || !pending) return;
    busy = true;
    writing = true;
    const epoch = generation;
    try {
      while (pending && account && epoch === generation) {
        const workspace = pending;
        pending = null;
        status("正在保存到云端…");
        try {
          const result = await request("/api/workspace", "PUT", {
            revision,
            workspace,
          });
          if (epoch !== generation) return;
          revision = result.revision;
          status("个人配置与学习进度已保存到云端");
        } catch (error) {
          if (epoch !== generation) return;
          if (error.status === 401) {
            lock(error.message);
          } else if (error.status === 409) {
            await recover_conflict();
          } else {
            pending ||= workspace;
            status(
              error.status === 400 ? error.message :
                "尚未同步，请勿关闭页面；网络恢复后会重试",
              true,
            );
          }
          break;
        }
      }
    } catch (error) {
      if (error.status === 401) lock(error.message);
      else status("云端连接失败，请勿关闭页面", true);
    } finally {
      busy = false;
      writing = false;
    }
  }

  function schedule_save(workspace) {
    /** 复制待保存快照，防止请求期间对象被后续交互修改。 */
    if (!account) return;
    pending = JSON.parse(JSON.stringify(workspace));
    status("有更改待同步…");
    clearTimeout(save_timer);
    save_timer = setTimeout(() => {
      saving = pump();
    }, 150);
  }

  async function flush() {
    /** 尝试完成保存，失败时阻止退出导致未同步数据丢失。 */
    clearTimeout(save_timer);
    if (saving) await saving;
    if (busy) return false;
    saving = pump();
    await saving;
    return !pending && Boolean(account);
  }

  async function poll() {
    /** 每五秒验证会话；后台恢复可见时也立即验证。 */
    if (!account || busy) return;
    if (pending) {
      saving = pump();
      await saving;
      return;
    }
    busy = true;
    const epoch = generation;
    try {
      const result = await request("/api/session");
      if (epoch !== generation) return;
      account = result.user;
      show_profile();
      if (result.revision !== revision) {
        if (pending) {
          await recover_conflict();
        } else {
          apply_snapshot(result);
        }
      } else if (!pending) {
        status("个人配置与学习进度已保存到云端");
      }
    } catch (error) {
      if (epoch !== generation) return;
      if (error.status === 401) lock(error.message);
      else status("暂时无法连接云端，请检查网络", true);
    } finally {
      busy = false;
      if (pending) {
        clearTimeout(save_timer);
        save_timer = setTimeout(() => { saving = pump(); }, 150);
      }
    }
  }

  find("#auth-mode").addEventListener("click", () => {
    registering = !registering;
    find("#auth-title").textContent = registering ? "创建学习账号" : "欢迎回到拾光";
    find("#auth-submit").textContent = registering ? "注册并开始学习" : "登录";
    find("#auth-mode").textContent = registering ? "已有账号？去登录" : "没有账号？去注册";
    find("#register-name-row").hidden = !registering;
    find("#auth-name").required = registering;
    find("#auth-password").autocomplete = registering
      ? "new-password" : "current-password";
    find("#auth-message").textContent = "";
  });

  find("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const submit = find("#auth-submit");
    submit.disabled = true;
    find("#auth-mode").disabled = true;
    find("#auth-message").textContent = "正在连接…";
    try {
      const result = await request(
        registering ? "/api/register" : "/api/login",
        "POST",
        {
          username: find("#auth-username").value.trim(),
          password: find("#auth-password").value,
          display_name: find("#auth-name").value.trim(),
        },
        false,
      );
      generation += 1;
      pending = null;
      apply_snapshot(result);
      form.reset();
      find("#auth-message").textContent = "";
      notify("已登录，配置与学习记录会自动保存到云端。");
    } catch (error) {
      find("#auth-message").textContent = error.status ? error.message :
        "无法连接服务器，请检查网络后重试。";
    } finally {
      submit.disabled = false;
      find("#auth-mode").disabled = false;
    }
  });

  find("#account-button").addEventListener("click", () => {
    if (!account) return;
    find("#profile-username").value = account.username;
    find("#profile-name").value = account.display_name;
    find("#profile-bio").value = account.bio;
    find("#profile-message").textContent = "";
    find("#profile-dialog").showModal();
  });

  find("#profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = find("#profile-save");
    button.disabled = true;
    const epoch = generation;
    try {
      const result = await request("/api/profile", "PUT", {
        display_name: find("#profile-name").value,
        bio: find("#profile-bio").value,
      });
      if (epoch !== generation) return;
      account = result.user;
      show_profile();
      find("#profile-dialog").close();
      notify("个人资料已保存到云端。");
    } catch (error) {
      if (epoch !== generation) return;
      if (error.status === 401) lock(error.message);
      else find("#profile-message").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  find("#logout-button").addEventListener("click", async () => {
    const button = find("#logout-button");
    button.disabled = true;
    try {
      if (!await flush()) {
        if (account) notify("尚有数据未同步或正在同步，请稍后再退出。");
        return;
      }
      await request("/api/logout", "POST", {});
      lock("已安全退出登录。");
    } catch (error) {
      if (error.status === 401) lock(error.message);
      else notify("退出失败，请检查网络后重试。");
    } finally {
      button.disabled = false;
    }
  });

  function sanitize_legacy_state(raw) {
    /** 规整旧浏览器缓存中的文本长度与条目上限，避免导入后被云端接口拒绝。 */
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.tasks) || !Array.isArray(raw.history)) {
      return null;
    }
    const copy = JSON.parse(JSON.stringify(raw));
    copy.tasks = copy.tasks.slice(0, 300).map((task) => ({
      ...task,
      title: String(task?.title || "").trim().slice(0, 100),
      category: String(task?.category || "阅读").trim().slice(0, 32),
      note: String(task?.note || "").trim().slice(0, 500),
    }));
    copy.history = copy.history.slice(-29);
    if (copy.tasks.length > 0 && !copy.tasks.some((item) => item.id === copy.selected_id)) {
      copy.selected_id = copy.tasks[0].id;
    } else if (copy.tasks.length === 0) {
      copy.selected_id = null;
    }
    return is_valid_state(copy) ? copy : null;
  }

  function import_legacy(legacy_state, legacy_prefs = {}) {
    /** 只在用户明确确认后，将旧浏览器记录导入当前账号。 */
    const clean_state = sanitize_legacy_state(legacy_state);
    if (!account || !clean_state) {
      notify("此浏览器没有可导入的旧版学习记录。");
      return;
    }
    if (!confirm("导入旧学习记录？这会替换当前账号的云端计划。")) return;
    const workspace = {
      state: clean_state,
      prefs: {
        theme: legacy_prefs?.theme === "dark" ? "dark" : "light",
        sound: legacy_prefs?.sound !== false,
      },
    };
    on_load(workspace);
    schedule_save(workspace);
    find("#profile-dialog").close();
    notify("已导入旧记录，正在同步；浏览器原始记录保持不变。");
  }

  find("#import-local-button").addEventListener("click", () => {
    if (!account) return;
    try {
      const legacy_state = JSON.parse(localStorage.getItem(storage_key));
      if (sanitize_legacy_state(legacy_state)) {
        let legacy_prefs = {};
        try {
          legacy_prefs = JSON.parse(
            localStorage.getItem("shiguang.daily-study.prefs.v1"),
          ) || {};
        } catch { /* 损坏偏好不阻止导入，原始数据保持不变。 */ }
        import_legacy(legacy_state, legacy_prefs);
        return;
      }
      if (location.protocol !== "https:") {
        notify("此浏览器没有可导入的旧版学习记录。");
        return;
      }
      const nonce = crypto.randomUUID();
      const legacy_origin = `http://${location.host}`;
      const legacy_window = window.open(
        `${legacy_origin}/legacy-import.html?nonce=${nonce}`,
        "shiguang-legacy-import",
      );
      if (!legacy_window) {
        notify("请允许弹出窗口，以读取原 HTTP 网站的旧记录。");
        return;
      }
      const epoch = generation;
      const receive = (event) => {
        if (event.origin !== legacy_origin ||
            event.source !== legacy_window ||
            event.data?.type !== "legacy-study" ||
            event.data?.nonce !== nonce) return;
        window.removeEventListener("message", receive);
        legacy_window.close();
        if (epoch !== generation) return;
        import_legacy(event.data.state, event.data.prefs);
      };
      window.addEventListener("message", receive);
      setTimeout(() => {
        window.removeEventListener("message", receive);
      }, 120_000);
      notify("请在弹出的旧站点页面读取记录，再返回这里确认。");
    } catch {
      notify("旧记录无法读取，原始数据未被修改。");
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!pending && !writing) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("online", poll);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
  });
  setInterval(poll, 5000);

  return {
    schedule_save,
    async start() {
      /** 恢复 cookie 会话；没有会话时只展示登录页面。 */
      if (location.protocol !== "https:" &&
          !["localhost", "127.0.0.1"].includes(location.hostname)) {
        find("#http-warning").hidden = false;
      }
      find("#auth-submit").disabled = true;
      try {
        apply_snapshot(await request("/api/session"));
      } catch (error) {
        lock(error.status === 401 ? "" : "连接云端失败，请稍后重试登录。");
      } finally {
        find("#auth-submit").disabled = false;
      }
    },
  };
}
