import {
  randomBytes as random_bytes,
  scrypt as scrypt_callback,
  timingSafeEqual as timing_safe_equal,
  createHash as create_hash,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scrypt_callback);
const scrypt_options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };


export function valid_password(password) {
  /** 检查密码长度，避免弱口令及过大的哈希输入。 */
  return typeof password === "string" &&
    password.length >= 10 && password.length <= 128 &&
    Buffer.byteLength(password) <= 512;
}


export async function hash_password(password) {
  /** 用随机盐和 scrypt 派生密码哈希，不存储明文密码。 */
  const salt = random_bytes(16).toString("hex");
  const key = await scrypt(password, salt, 64, scrypt_options);
  return `scrypt:${salt}:${key.toString("hex")}`;
}


export async function verify_password(password, encoded) {
  /** 常量时间比较密码；未知账号也执行同等成本的派生计算。 */
  const [, salt, expected] = (encoded || "").split(":");
  const key = await scrypt(
    password,
    salt || "00000000000000000000000000000000",
    64,
    scrypt_options,
  );
  const expected_key = Buffer.from(expected || "00".repeat(64), "hex");
  return expected_key.length === key.length &&
    timing_safe_equal(key, expected_key) && Boolean(encoded);
}


export function token_hash(token) {
  /** 仅将高熵会话令牌的 SHA-256 摘要存入数据库。 */
  return create_hash("sha256").update(token).digest("hex");
}


export function session_token(request) {
  /** 读取 HttpOnly 会话 cookie；无效 cookie 视为未登录。 */
  const value = (request.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("study_session="))
    ?.slice("study_session=".length);
  return /^[a-f0-9]{64}$/.test(value || "") ? value : "";
}
