import {
  randomBytes as random_bytes,
  randomUUID as random_uuid,
} from "node:crypto";
import { pool } from "./database.js";
import {
  hash_password,
  verify_password,
  valid_password,
  token_hash,
  session_token,
} from "./auth.js";
import { create_state, is_valid_state } from "./model.js";

const session_seconds = 7 * 24 * 60 * 60;
const attempts = new Map();
let active_hashes = 0;


class HttpError extends Error {
  /** 表示可安全返回给客户端的 HTTP 错误。 */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}


function send(response, status, body) {
  /** 返回禁止缓存的 JSON，不暴露数据库错误细节。 */
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}


function set_cookie(response, token, secure, seconds = session_seconds) {
  /** 设置同站点 HttpOnly cookie，HTTPS 部署必须启用 Secure。 */
  const flags = secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `study_session=${token}; Path=/; HttpOnly; SameSite=Strict` +
      `; Max-Age=${seconds}${flags}`,
  );
}


function check_origin(request, origin) {
  /** 自定义请求头和同源校验共同防止跨站请求伪造。 */
  if (request.headers["x-requested-with"] !== "daily-study") {
    throw new HttpError(403, "请求来源不合法，请刷新页面。");
  }
  if (request.headers.origin !== origin) {
    throw new HttpError(403, "不允许跨站操作。");
  }
}


function rate_limit(request, username, trust_proxy) {
  /** 限制认证请求并限制缓存大小，减轻密码猜测与资源耗尽。 */
  const address = trust_proxy
    ? request.headers["x-real-ip"] || request.socket.remoteAddress
    : request.socket.remoteAddress;
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (entry.until <= now) attempts.delete(key);
  }
  const keys = [
    [`ip:${address}`, 30],
    [`user:${username}`, 15],
  ];
  if (attempts.size > 10_000 || active_hashes >= 4) {
    throw new HttpError(429, "请求较多，请稍后再试。");
  }
  for (const [key, limit] of keys) {
    const entry = attempts.get(key) || { count: 0, until: now + 600_000 };
    entry.count += 1;
    attempts.set(key, entry);
    if (entry.count > limit) {
      throw new HttpError(429, "登录尝试过多，请十分钟后重试。");
    }
  }
}


async function read_json(request) {
  /** 读取有大小限制的 JSON 请求；超限或损坏时返回客户端错误。 */
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "请使用 JSON 请求。");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512 * 1024) {
      throw new HttpError(413, "数据过大，请减少任务数量。");
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body;
  } catch {
    throw new HttpError(400, "请求数据格式不正确。");
  }
}


function user_info(row) {
  /** 只返回可公开给当前用户的个人资料。 */
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    bio: row.bio,
  };
}


function snapshot(row) {
  /** 生成账号快照，不返回密码哈希或会话令牌。 */
  return {
    user: user_info(row),
    workspace: row.workspace,
    revision: row.revision,
    session_id: row.session_id,
  };
}


export function valid_workspace(workspace) {
  /** 限制云端任务数据与偏好结构，避免无界存储和非法状态。 */
  if (!workspace || typeof workspace !== "object") return false;
  const { state, prefs } = workspace;
  if (!is_valid_state(state) || state.tasks.length > 300 ||
      state.history.length > 29) return false;
  if (!prefs || !["light", "dark"].includes(prefs.theme) ||
      typeof prefs.sound !== "boolean") return false;
  return state.tasks.every((task) =>
    task.id.length <= 64 && task.title.length <= 100 &&
    task.category.length <= 32 && task.note.length <= 500
  );
}


async function authenticate(client, request, require_session_id) {
  /** 行锁使登录轮换与旧会话的写入按顺序执行，防止并发越权。 */
  const token = session_token(request);
  if (!token) throw new HttpError(401, "请先登录。");
  const result = await client.query(
    `SELECT * FROM study_users
     WHERE session_hash = $1 AND session_expires_at > now()
     FOR UPDATE`,
    [token_hash(token)],
  );
  const row = result.rows[0];
  const expected_id = request.headers["x-session-id"];
  if (!row || ((require_session_id || expected_id) &&
      expected_id !== row.session_id)) {
    throw new HttpError(401, "登录已过期或账号已在其他设备登录，请重新登录。");
  }
  return row;
}


async function login(request, response, body, config, registering) {
  /** 注册或登录，原子替换唯一会话，使旧设备立即失去 API 权限。 */
  const username = String(body.username || "").trim().toLowerCase();
  rate_limit(request, username.slice(0, 32), config.trust_proxy);
  if (!/^[a-z0-9_]{3,32}$/.test(username) ||
      !valid_password(body.password)) {
    throw new HttpError(
      400,
      "用户名为 3～32 位字母、数字或下划线；密码为 10～128 位。",
    );
  }
  const display_name = String(body.display_name || username).trim();
  if (registering && (!display_name || display_name.length > 40)) {
    throw new HttpError(400, "昵称需为 1～40 个字符。");
  }
  const token = random_bytes(32).toString("hex");
  const session_id = random_uuid();
  const expires_at = new Date(Date.now() + session_seconds * 1000);
  let result;
  active_hashes += 1;
  try {
    if (registering) {
      const encoded = await hash_password(body.password);
      const workspace = {
        state: create_state(),
        prefs: { theme: "dark", sound: true },
      };
      result = await pool.query(
        `INSERT INTO study_users
         (id, username, password_hash, display_name, workspace,
          session_hash, session_id, session_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          random_uuid(), username, encoded, display_name, workspace,
          token_hash(token), session_id, expires_at,
        ],
      );
    } else {
      const found = await pool.query(
        "SELECT id, password_hash FROM study_users WHERE username = $1",
        [username],
      );
      const user = found.rows[0];
      if (!await verify_password(body.password, user?.password_hash)) {
        throw new HttpError(401, "用户名或密码不正确。");
      }
      result = await pool.query(
        `UPDATE study_users
         SET session_hash = $1, session_id = $2,
             session_expires_at = $3, updated_at = now()
         WHERE id = $4 AND password_hash = $5 RETURNING *`,
        [
          token_hash(token), session_id, expires_at, user.id, user.password_hash,
        ],
      );
      if (!result.rows.length) {
        throw new HttpError(401, "账号信息已改变，请重新登录。");
      }
    }
  } finally {
    active_hashes -= 1;
  }
  set_cookie(response, token, config.secure_cookie);
  send(response, registering ? 201 : 200, snapshot(result.rows[0]));
}


export async function handle_api(request, response, pathname, config) {
  /**
   * 处理账号、个人资料和云端工作区接口。
   *
   * Args:
   *   request: Node.js HTTP 请求。
   *   response: HTTP 响应对象。
   *   pathname: URL 路径，必须以 /api/ 开头。
   *   config: 包含 origin、secure_cookie、trust_proxy 的部署配置。
   *
   * Returns:
   *   响应完成后解决的 Promise；预期请求错误转换为 HTTP 状态码。
   */
  let client;
  try {
    const method = request.method;
    if (pathname === "/api/health" && method === "GET") {
      await pool.query("SELECT 1");
      send(response, 200, { ok: true });
      return;
    }
    const writing = ["POST", "PUT"].includes(method);
    if (writing) check_origin(request, config.origin);
    if ((pathname === "/api/register" || pathname === "/api/login") &&
        method === "POST") {
      await login(
        request, response, await read_json(request),
        config, pathname === "/api/register",
      );
      return;
    }
    const routes = {
      "/api/session": "GET",
      "/api/workspace": "PUT",
      "/api/profile": "PUT",
      "/api/logout": "POST",
    };
    if (routes[pathname] !== method) {
      throw new HttpError(404, "接口不存在。");
    }
    const body = writing ? await read_json(request) : null;
    client = await pool.connect();
    await client.query("BEGIN");
    let row = await authenticate(client, request, writing);
    if (pathname === "/api/workspace") {
      if (!Number.isInteger(body.revision) ||
          !valid_workspace(body.workspace)) {
        throw new HttpError(400, "学习数据格式不正确或超过限制。");
      }
      if (body.revision !== row.revision) {
        throw new HttpError(409, "其他页面已更新数据，已重新加载云端版本。");
      }
      const result = await client.query(
        `UPDATE study_users
         SET workspace = $1, revision = revision + 1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [body.workspace, row.id],
      );
      row = result.rows[0];
    } else if (pathname === "/api/profile") {
      if (typeof body.display_name !== "string" ||
          !body.display_name.trim() || body.display_name.trim().length > 40 ||
          typeof body.bio !== "string" || body.bio.length > 200) {
        throw new HttpError(400, "昵称限 1～40 字，个人简介限 200 字。");
      }
      const result = await client.query(
        `UPDATE study_users
         SET display_name = $1, bio = $2, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [body.display_name.trim(), body.bio.trim(), row.id],
      );
      row = result.rows[0];
    } else if (pathname === "/api/logout") {
      await client.query(
        `UPDATE study_users SET session_hash = NULL, session_id = NULL,
         session_expires_at = NULL WHERE id = $1`,
        [row.id],
      );
    }
    await client.query("COMMIT");
    if (pathname === "/api/logout") {
      set_cookie(response, "", config.secure_cookie, 0);
      send(response, 200, { ok: true });
    } else {
      send(response, 200, snapshot(row));
    }
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    const status = error.status || (error.code === "23505" ? 409 : 503);
    if (status >= 500) {
      console.error("API 请求失败：", error.code || error.name);
    }
    send(response, status, {
      error: error.status ? error.message :
        error.code === "23505" ? "用户名已被注册。" :
          "服务暂时不可用，请稍后重试。",
    });
  } finally {
    client?.release();
  }
}
