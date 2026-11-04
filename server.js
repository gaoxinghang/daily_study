import { createServer as create_server } from "node:http";
import { readFile as read_file } from "node:fs/promises";
import { networkInterfaces as network_interfaces } from "node:os";

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
]);

const server = create_server(async (request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    response.writeHead(400);
    response.end("Bad request");
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
    console.log("服务未设置登录限制，请仅在可信网络使用。");
  }
});
