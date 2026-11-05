import { migrate, pool } from "./database.js";

try {
  await migrate();
  console.log("数据库结构已就绪。");
} catch (error) {
  console.error("数据库初始化失败：", error.code || error.name);
  process.exitCode = 1;
} finally {
  await pool.end();
}
