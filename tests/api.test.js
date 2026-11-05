import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID as random_uuid } from "node:crypto";
import { migrate, pool } from "../database.js";


async function start_server(context) {
  /** 启动临时 API 进程，继承显式指定的隔离测试数据库配置。 */
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      COOKIE_SECURE: "true",
      PUBLIC_ORIGIN: "https://study.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "exit");
    child.kill();
    await closed;
  });
  let output = "";
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("启动超时")), 5000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("服务提前退出")));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/监听地址：[^\n]+:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
}


test("PostgreSQL 账号、同步、隔离与单会话端到端", {
  skip: process.env.TEST_DATABASE !== "1",
}, async (context) => {
  assert.match(process.env.PGDATABASE || "", /test/);
  await migrate();
  const username = `test_${random_uuid().slice(0, 8)}`;
  const other_username = `${username}_other`;
  context.after(async () => {
    await pool.query("DELETE FROM study_users WHERE username = ANY($1)", [
      [username, other_username],
    ]);
    await pool.end();
  });
  let base_url = await start_server(context);
  const password = "Integration-password-483!";

  async function call(path, method = "GET", body, device = {}, extra = {}) {
    const response = await fetch(`${base_url}${path}`, {
      method,
      headers: {
        Origin: "https://study.test",
        "X-Requested-With": "daily-study",
        "Content-Type": "application/json",
        ...(device.cookie ? { Cookie: device.cookie } : {}),
        ...(device.session_id ? { "X-Session-Id": device.session_id } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return {
      status: response.status,
      data,
      cookie: response.headers.get("set-cookie"),
    };
  }

  let first;
  let workspace;
  await context.test("注册、密码哈希、Secure HttpOnly cookie", async () => {
    const result = await call("/api/register", "POST", {
      username, password, display_name: "测试用户",
    });
    assert.equal(result.status, 201);
    assert.match(result.cookie, /HttpOnly/);
    assert.match(result.cookie, /Secure/);
    assert.match(result.cookie, /SameSite=Strict/);
    assert.equal(result.data.password_hash, undefined);
    first = {
      cookie: result.cookie.split(";")[0],
      session_id: result.data.session_id,
    };
    workspace = result.data.workspace;
    const stored = await pool.query(
      "SELECT password_hash, session_hash FROM study_users WHERE username=$1",
      [username],
    );
    assert.match(stored.rows[0].password_hash, /^scrypt:/);
    assert.notEqual(stored.rows[0].session_hash, first.cookie.split("=")[1]);
    assert.equal((await call("/api/register", "POST", {
      username, password,
    })).status, 409);
    assert.equal((await call("/api/login", "POST", {
      username, password: "incorrect-password",
    })).status, 401);
  });

  await context.test("未登录、跨站和缺少会话代次的请求被拒绝", async () => {
    assert.equal((await call("/api/session")).status, 401);
    assert.equal((await call("/api/profile", "PUT", {}, first, {
      Origin: "https://attacker.example",
    })).status, 403);
    assert.equal((await call("/api/profile", "PUT", {}, first, {
      "X-Requested-With": "",
    })).status, 403);
    assert.equal((await call("/api/profile", "PUT", {}, {
      cookie: first.cookie,
    })).status, 401);
  });

  await context.test("个人资料和工作区持久化，过期 revision 拒绝覆盖", async () => {
    assert.equal((await call("/api/profile", "PUT", {
      display_name: "新的昵称", bio: "跨设备简介",
    }, first)).status, 200);
    workspace.prefs = { theme: "dark", sound: false };
    workspace.state.tasks[0].title = "云端同步的任务";
    const result = await call("/api/workspace", "PUT", {
      revision: 0, workspace,
    }, first);
    assert.equal(result.status, 200);
    assert.equal(result.data.revision, 1);
    assert.equal((await call("/api/workspace", "PUT", {
      revision: 0, workspace,
    }, first)).status, 409);
    assert.equal((await call("/api/workspace", "PUT", {
      revision: 1, workspace: { state: null },
    }, first)).status, 400);
  });

  let second;
  await context.test("第二设备登录恢复配置，第一设备读取写入退出均失效", async () => {
    const result = await call("/api/login", "POST", { username, password });
    assert.equal(result.status, 200);
    assert.equal(result.data.user.display_name, "新的昵称");
    assert.equal(result.data.user.bio, "跨设备简介");
    assert.deepEqual(result.data.workspace, workspace);
    second = {
      cookie: result.cookie.split(";")[0],
      session_id: result.data.session_id,
    };
    assert.equal((await call("/api/session", "GET", undefined, first)).status, 401);
    assert.equal((await call("/api/workspace", "PUT", {
      revision: 1, workspace,
    }, first)).status, 401);
    assert.equal((await call("/api/logout", "POST", {}, first)).status, 401);
    assert.equal((await call("/api/session", "GET", undefined, second)).status, 200);
    assert.equal((await call("/api/profile", "PUT", {
      display_name: "旧标签", bio: "",
    }, { cookie: second.cookie, session_id: first.session_id })).status, 401);
  });

  await context.test("账号隔离，重新启动服务后数据与会话仍然有效", async () => {
    const other = await call("/api/register", "POST", {
      username: other_username, password,
    });
    assert.equal(other.status, 201);
    assert.equal(other.data.workspace.prefs.theme, "light");
    assert.notEqual(other.data.user.id,
      (await call("/api/session", "GET", undefined, second)).data.user.id);
    base_url = await start_server(context);
    const restored = await call("/api/session", "GET", undefined, second);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.data.workspace, workspace);
  });

  await context.test("并发登录只有一个有效会话，退出和过期立即生效", async () => {
    const responses = await Promise.all([
      call("/api/login", "POST", { username, password }),
      call("/api/login", "POST", { username, password }),
    ]);
    const devices = responses.map((result) => ({
      cookie: result.cookie.split(";")[0],
      session_id: result.data.session_id,
    }));
    const sessions = await Promise.all(devices.map((device) =>
      call("/api/session", "GET", undefined, device)
    ));
    assert.deepEqual(sessions.map((item) => item.status).sort(), [200, 401]);
    const active = devices[sessions.findIndex((item) => item.status === 200)];
    assert.equal((await call("/api/logout", "POST", {}, active)).status, 200);
    assert.equal((await call("/api/session", "GET", undefined, active)).status, 401);
    const logged_in = await call("/api/login", "POST", { username, password });
    await pool.query(
      "UPDATE study_users SET session_expires_at = now() WHERE username=$1",
      [username],
    );
    assert.equal((await call("/api/session", "GET", undefined, {
      cookie: logged_in.cookie.split(";")[0],
      session_id: logged_in.data.session_id,
    })).status, 401);
  });
});
