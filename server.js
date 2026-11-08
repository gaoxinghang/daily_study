import { createServer as create_server } from "node:http";
import { readFile as read_file } from "node:fs/promises";
import { networkInterfaces as network_interfaces } from "node:os";
import { handle_api } from "./api.js";
import { pool } from "./database.js";

if (process.env.NODE_ENV === "production") {
  const origin = new URL(process.env.PUBLIC_ORIGIN || "http://invalid");
  if (origin.protocol !== "https:" ||
      origin.origin !== process.env.PUBLIC_ORIGIN ||
      process.env.COOKIE_SECURE !== "true") {
    throw new Error("生产环境必须配置 HTTPS 来源与 Secure 会话 cookie。");
  }
}

const host = process.env.HOST || "0.0.0.0";
const raw_port = process.env.PORT;
const parsed_port =
  raw_port !== undefined && raw_port !== "" ? Number(raw_port) : 3000;
const port =
  Number.isInteger(parsed_port) && parsed_port >= 0 && parsed_port <= 65535
    ? parsed_port
    : 3000;

const public_files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/model.js", ["model.js", "text/javascript; charset=utf-8"]],
  ["/cloud.js", ["cloud.js", "text/javascript; charset=utf-8"]],
  ["/account.css", ["account.css", "text/css; charset=utf-8"]],
  ["/space.css", ["space.css", "text/css; charset=utf-8"]],
  ["/nebula.js", ["nebula.js", "text/javascript; charset=utf-8"]],
  ["/legacy-import.html", ["legacy-import.html", "text/html; charset=utf-8"]],
  ["/legacy-import.js", ["legacy-import.js", "text/javascript; charset=utf-8"]],
]);

const server = create_server(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "));
  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (pathname.startsWith("/api/")) {
    await handle_api(request, response, pathname, {
      origin: process.env.PUBLIC_ORIGIN || `http://${request.headers.host}`,
      secure_cookie: process.env.COOKIE_SECURE === "true",
      trust_proxy: process.env.TRUST_PROXY === "true",
    });
    return;
  }
  const file = public_files.get(pathname);
  if (!file || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  try {
    const content = await read_file(new URL(file[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(500);
    response.end("Unable to load file");
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

server.on("error", (error) => {
  console.error("启动失败：", error.message);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const actual_port = server.address().port;
  console.log(`监听地址：${host}:${actual_port}`);
  if (host === "0.0.0.0" || host === "127.0.0.1") {
    console.log(`本机访问：http://localhost:${actual_port}`);
  }
  if (host === "0.0.0.0") {
    const addresses = new Set(
      Object.values(network_interfaces())
        .flat()
        .filter((item) => item && item.family === "IPv4" && !item.internal)
        .map((item) => item.address),
    );
    for (const address of addresses) {
      console.log(`网络访问：http://${address}:${actual_port}`);
    }
    console.log("手机请连接同一局域网，选择电脑 Wi-Fi 或有线网卡的地址。");
    console.log("云端数据需登录访问；公网部署请配置 HTTPS。");
  }
});
