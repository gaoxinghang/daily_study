import { createServer as create_server } from "node:http";
import { readFile as read_file } from "node:fs/promises";

const port = Number(process.env.PORT || 3000);
const public_files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/model.js", ["model.js", "text/javascript; charset=utf-8"]],
]);

const server = create_server(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
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

server.listen(port, "127.0.0.1", () => {
  console.log(`拾光已启动：http://localhost:${port}`);
});
