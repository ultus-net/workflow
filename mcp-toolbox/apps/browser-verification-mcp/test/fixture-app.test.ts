import assert from "node:assert/strict";
import test from "node:test";

import { HOSTILE_HTML, INDEX_HTML, startFixtureApp } from "./fixtures/fixture-app.js";

test("fixture app serves the greeting page and the hostile page on loopback only", async () => {
  const fixture = await startFixtureApp();
  try {
    assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const index = await fetch(`${fixture.url}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /id="name"/);
    assert.match(html, /id="greet"/);
    assert.match(html, /id="output"/);
    assert.match(INDEX_HTML, /Hello, /);

    const hostile = await fetch(`${fixture.url}/hostile`);
    assert.equal(hostile.status, 200);
    assert.match(await hostile.text(), /hostile-content/);
    assert.match(HOSTILE_HTML, /fetch\('\/exfil/);
    assert.match(HOSTILE_HTML, /new Function/);

    const missing = await fetch(`${fixture.url}/nope`);
    assert.equal(missing.status, 404);
    assert.ok((fixture.hits.get("/") ?? 0) >= 1);
    assert.ok((fixture.hits.get("/hostile") ?? 0) >= 1);
  } finally {
    await fixture.close();
  }
});