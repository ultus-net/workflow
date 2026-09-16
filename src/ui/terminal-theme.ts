/**
 * Terminal-derived composer tint (technique ported from the OpenRouter
 * create-agent-tui skill's adaptive input background — the same approach
 * Codex CLI uses). Before Ink takes over stdin, the surface queries the
 * terminal's real background color via OSC 11 and blends a subtle tint
 * derived from it: dark terminals get white at 12% alpha, light terminals
 * get black at 4%. The result is an Ink background color value the composer
 * renders as the "block" input style.
 *
 * Fail-soft by design: piped stdin, terminals that do not answer OSC 11
 * (tmux without passthrough, most CI environments), or query errors resolve
 * `undefined` and the caller keeps the borderless-fallback bordered
 * composer. NO_COLOR degrades the tint automatically because chalk drops
 * to level 0 and strips backgrounds.
 */

/** Perceived luminance threshold separating light from dark backgrounds. */
const LIGHT_THRESHOLD = 128;

/** OSC 11 response timeout: terminals that cannot answer inside this window fall back. */
const OSC_TIMEOUT_MS = 200;

function blend(fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

function isLight(r: number, g: number, b: number): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b > LIGHT_THRESHOLD;
}

/**
 * Derive the composer tint from a terminal background RGB triple.
 * Light backgrounds receive a near-black wash, dark ones a near-white wash,
 * so the composer reads as "the user's theme, slightly raised".
 */
export function blendTerminalTint(background: [number, number, number]): string {
  const [r, g, b] = background;
  const [top, alpha]: [[number, number, number], number] = isLight(r, g, b)
    ? [[0, 0, 0], 0.04]
    : [[255, 255, 255], 0.12];
  const [tr, tg, tb] = blend(top, [r, g, b], alpha);
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${hex(tr)}${hex(tg)}${hex(tb)}`;
}

function parseOsc11Response(buffer: string): [number, number, number] | undefined {
  // Response shape: <ESC>]11;rgb:RRRR/GGGG/BBBB<ESC>\ (or BEL). Parsed without
  // a control-character regex: locate the payload, split on "/", keep hex.
  const prefix = "]11;rgb:";
  const start = buffer.indexOf(prefix);
  if (start === -1) return undefined;
  const channels = buffer.slice(start + prefix.length).split("/");
  if (channels.length < 3) return undefined;
  const rgb: [number, number, number] = [0, 0, 0];
  // XParseColor semantics: channels carry 1-4 hex digits scaled to full
  // intensity by their digit count ("f" is full red, "ffff" likewise), so
  // normalize each channel to 0-255 rather than trusting the high bytes.
  for (let index = 0; index < 3; index += 1) {
    const digits = channels[index]!.replace(/[^0-9a-fA-F]/g, "");
    if (digits.length === 0 || digits.length > 4) return undefined;
    const raw = Number.parseInt(digits, 16);
    const max = 16 ** digits.length - 1;
    rgb[index] = Math.round((raw / max) * 255);
  }
  return rgb;
}

/**
 * Query the terminal's own background color (OSC 11) and derive the composer
 * tint. Must run BEFORE Ink installs its stdin handling — call it in the CLI
 * entry, then pass the result to `WorkflowTui` as `composerBackground`.
 * Resolves undefined whenever the terminal cannot or will not answer.
 */
export function detectTerminalBackground(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || !process.stdout.isTTY) {
      resolve(undefined);
      return;
    }
    let settled = false;
    let buffer = "";
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      try {
        stdin.setRawMode(wasRaw);
        // Leave the TTY read-started and flowing: Ink consumes stdin through
        // a 'readable' pump and never calls resume(), so a paused stdin
        // starves the whole interface of keystrokes. Bytes that arrive before
        // Ink attaches its listener are discarded, exactly as before.
        stdin.resume();
      } catch {
        // Raw-mode restore is best-effort; Ink reconfigures stdin next.
      }
      resolve(value);
    };
    const wasRaw = stdin.isRaw ?? false;
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const rgb = parseOsc11Response(buffer);
      if (rgb !== undefined) finish(blendTerminalTint(rgb));
    };
    const timer = setTimeout(() => {
      // Final drain: data may have arrived between the last parse attempt and
      // this tick; give the accumulated buffer one last chance before the
      // bordered fallback. A response arriving after this window is dropped
      // by the TUI's OSC-response input filter (see tui.tsx useInput).
      const rgb = parseOsc11Response(buffer);
      finish(rgb === undefined ? undefined : blendTerminalTint(rgb));
    }, OSC_TIMEOUT_MS);
    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      process.stdout.write("\x1b]11;?\x07");
    } catch {
      finish(undefined);
    }
  });
}
