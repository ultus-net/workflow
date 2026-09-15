import type { OpenCodeSessionClient } from "./opencode-session.js";

export function createOpenCodeSessionClient(baseUrl: string): OpenCodeSessionClient {
  const base = baseUrl.replace(/\/$/, "");
  return {
    create: () => request(`${base}/session`, {}),
    prompt: ({ path, body }) => request(`${base}/session/${encodeURIComponent(path.id)}/message`, body),
    abort: ({ path }) => request(`${base}/session/${encodeURIComponent(path.id)}/abort`, {}),
    event: { subscribe: () => subscribeSse(`${base}/event`) },
  };
}

async function request(url: string, body: unknown): Promise<{ data?: never; error?: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { error };
  }
  if (!response.ok) return { error: new Error(`OpenCode request failed with status ${response.status}`) };
  return { data: await response.json() as never };
}

async function subscribeSse(url: string): Promise<{ stream: AsyncIterable<unknown> }> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`OpenCode event stream failed with status ${response.status}`);
  }
  return { stream: sseFrames(response.body) };
}

async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        return;
      }
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) yield JSON.parse(data) as unknown;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
