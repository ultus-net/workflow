import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const token = "t".repeat(64);
const server = createServer((request, response) => {
  if (request.url === "/health" && request.headers.authorization === `Bearer ${token}`) {
    response.statusCode = 200;
    response.end("ok");
    return;
  }
  response.statusCode = 400;
  response.end("bad");
});
server.listen(0, "127.0.0.1", () => {
  const discoveryPath = process.env.FAKE_HUB_DISCOVERY_PATH;
  const delay = Number(process.env.FAKE_HUB_DELAY_MS ?? 0);
  setTimeout(() => {
    mkdirSync(dirname(discoveryPath), { recursive: true });
    writeFileSync(
      discoveryPath,
      JSON.stringify({ hubId: "fake-hub", endpoint: `http://127.0.0.1:${server.address().port}`, token }),
    );
  }, delay);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
