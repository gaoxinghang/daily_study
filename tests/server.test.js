import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { networkInterfaces as network_interfaces } from "node:os";


async function start_server(context, host) {
  /**
   * 启动隔离的临时测试服务器，并在测试后回收进程。
   *
   * Args:
   *   context: Node.js 测试上下文。
   *   host: 可选的监听地址；省略时测试默认配置。
   *
   * Returns:
   *   服务实际分配的端口及启动输出。
   */
  const env = { ...process.env, PORT: "0" };
  delete env.HOST;
  if (host) env.HOST = host;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../", import.meta.url),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "exit");
    child.kill();
    await closed;
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error("测试服务器启动超时"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`测试服务器提前退出：${code}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/监听地址：[^\n]+:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ port: Number(match[1]), output });
      }
    });
  });
}


test("默认监听所有 IPv4 接口并只提供白名单静态文件", async (context) => {
  const { port, output } = await start_server(context);
  assert.match(output, /监听地址：0\.0\.0\.0:/);
  const base_url = `http://127.0.0.1:${port}`;
  const response = await fetch(base_url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /<html[^>]+data-theme="dark"/);
  assert.match(html, /name="theme-color" content="#03060d"/);
  assert.doesNotMatch(html, /space-hud|theme-toggle|motion-toggle/);
  assert.match(html, /id="ambient-canvas"/);
  assert.match(html, /id="account-button"/);
  const css_response = await fetch(`${base_url}/styles.css`);
  assert.match(css_response.headers.get("content-type"), /text\/css/);
  await css_response.text();
  for (const [path, content_type] of [
    ["/space.css", "text/css"],
    ["/nebula.js", "text/javascript"],
  ]) {
    const asset = await fetch(`${base_url}${path}`);
    assert.equal(asset.status, 200);
    assert.ok(asset.headers.get("content-type").startsWith(content_type));
    assert.ok((await asset.text()).length > 0);
  }
  for (const path of [
    "/.env", "/.git/config", "/server.js", "/README.md",
    "/api.js", "/auth.js", "/database.js", "/package.json",
    "/deploy/backup.sh", "/node_modules/pg/package.json",
  ]) {
    const blocked = await fetch(`${base_url}${path}`);
    assert.equal(blocked.status, 404);
    await blocked.text();
  }
  const addresses = Object.values(network_interfaces()).flat();
  const network = addresses.find((item) => {
    return item && item.family === "IPv4" && !item.internal;
  });
  if (network) {
    const network_response = await fetch(
      `http://${network.address}:${port}/`,
    );
    assert.equal(network_response.status, 200);
    await network_response.text();
  }
});


test("支持通过 HOST 恢复为仅本机访问", async (context) => {
  const { port, output } = await start_server(context, "127.0.0.1");
  assert.match(output, /监听地址：127\.0\.0\.1:/);
  const response = await fetch(`http://127.0.0.1:${port}/model.js`);
  assert.equal(response.status, 200);
  await response.text();
});
