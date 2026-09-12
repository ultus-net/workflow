import { Transform } from "node:stream";

const MAX_FAILURE_BYTES = 16 * 1024;
const MAX_TEST_NAME_BYTES = 4 * 1024;

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
  return { text, truncated: true };
}

function failureMessage(data: Record<string, unknown>): { text: string; truncated: boolean } {
  const details = data.details as { error?: Error & { cause?: Error } } | undefined;
  const error = details?.error?.cause ?? details?.error;
  return truncateUtf8(error?.stack ?? error?.message ?? String(data.name ?? "Test failed"), MAX_FAILURE_BYTES);
}

export default new Transform({
  writableObjectMode: true,
  transform(event: { type: string; data: Record<string, unknown> }, _encoding, callback) {
    if (event.type !== "test:pass" && event.type !== "test:fail") return callback();
    const failure = event.type === "test:fail" ? failureMessage(event.data) : undefined;
    const name = truncateUtf8(String(event.data.name ?? ""), MAX_TEST_NAME_BYTES);
    callback(null, `${JSON.stringify({
      type: event.type,
      name: name.text,
      nameTruncated: name.truncated,
      file: event.data.file,
      nesting: event.data.nesting,
      durationMs: (event.data.details as { duration_ms?: number } | undefined)?.duration_ms ?? 0,
      detailType: (event.data.details as { type?: string } | undefined)?.type,
      skip: Boolean(event.data.skip),
      todo: Boolean(event.data.todo),
      message: failure?.text,
      messageTruncated: failure?.truncated ?? false,
    })}\n`);
  },
});
