import test from "node:test";
import assert from "node:assert/strict";
import {
  hash_password,
  verify_password,
  valid_password,
  session_token,
  token_hash,
} from "../auth.js";
import { valid_workspace } from "../api.js";
import { create_state } from "../model.js";


test("密码使用独立随机盐且只能由正确密码验证", async () => {
  const password = "test-password-123";
  const first = await hash_password(password);
  const second = await hash_password(password);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verify_password(password, first), true);
  assert.equal(await verify_password("wrong-password", first), false);
  assert.equal(await verify_password(password, undefined), false);
});


test("限制密码长度并严格解析会话 cookie", () => {
  assert.equal(valid_password("short"), false);
  assert.equal(valid_password("a".repeat(129)), false);
  assert.equal(valid_password("long-enough-password"), true);
  const token = "ab".repeat(32);
  assert.equal(session_token({ headers: {
    cookie: `other=1; study_session=${token}`,
  } }), token);
  assert.equal(session_token({ headers: {
    cookie: "study_session=invalid",
  } }), "");
  assert.equal(session_token({ headers: {} }), "");
  assert.equal(token_hash(token).length, 64);
  assert.notEqual(token_hash(token), token);
});


test("云端工作区校验主题、状态及数据量边界", () => {
  const workspace = {
    state: create_state(),
    prefs: { theme: "dark", sound: false },
  };
  assert.equal(valid_workspace(workspace), true);
  workspace.prefs.theme = "invalid";
  assert.equal(valid_workspace(workspace), false);
  workspace.prefs.theme = "light";
  workspace.state.tasks[0].title = "x".repeat(101);
  assert.equal(valid_workspace(workspace), false);
  assert.equal(valid_workspace(null), false);
});
