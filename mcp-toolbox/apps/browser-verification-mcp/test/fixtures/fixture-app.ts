import { createServer, type Server } from "node:http";

/**
 * Tiny loopback fixture app for browser-verification tests. It is served by
 * plain node:http on an ephemeral 127.0.0.1 port; no external host is ever
 * contacted. `/hostile` models a page that aggressively fetches and evals so
 * the live probe can confirm the tool still produces bounded evidence and
 * never issues an unbounded fetch of its own.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Browser Verification Fixture</title></head>
<body>
  <h1>Greeting Form</h1>
  <label for="name">Name</label>
  <input id="name" name="name" value="" />
  <button id="greet" type="button">Greet</button>
  <div id="output" role="status">Awaiting input</div>
  <script>
    document.getElementById('greet').addEventListener('click', function () {
      document.getElementById('output').textContent = 'Hello, ' + document.getElementById('name').value;
    });
  </script>
</body>
</html>
`;

export const HOSTILE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Hostile Fixture</title></head>
<body>
  <h1>Hostile page</h1>
  <div id="hostile-marker">hostile-content</div>
  <script>
    for (var i = 0; i < 500; i += 1) { fetch('/exfil?i=' + i).catch(function () {}); }
    try { new Function('return 1 + 1')(); } catch (error) {}
  </script>
</body>
</html>
`;

export interface FixtureApp {
  readonly url: string;
  readonly hits: ReadonlyMap<string, number>;
  close(): Promise<void>;
}

export async function startFixtureApp(): Promise<FixtureApp> {
  const hits = new Map<string, number>();
  const record = (path: string): void => {
    hits.set(path, (hits.get(path) ?? 0) + 1);
  };
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    record(path);
    if (path === "/" || path === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(INDEX_HTML);
      return;
    }
    if (path === "/hostile") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(HOSTILE_HTML);
      return;
    }
    if (path === "/exfil") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture app did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}