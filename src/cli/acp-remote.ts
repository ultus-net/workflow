#!/usr/bin/env node
/**
 * Remote ACP bridge entry point.
 *
 * Runs an ACP agent over stdio (what Workflow drives) backed by a remote or
 * attached OpenCode server's HTTP/SSE API. Advisory posture; see
 * `docs/OPENCODE_REMOTE_ACP_SPEC.md`.
 *
 * Usage:
 *   node --import tsx src/cli/acp-remote.ts --url http://[IP_ADDRESS]:4096 [--cwd DIR]
 *
 * Environment: OPENCODE_SERVER_URL, OPENCODE_SERVER_USERNAME,
 * OPENCODE_SERVER_PASSWORD. The password is never logged.
 */

import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type CancelNotification,
  type CloseSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
} from "@agentclientprotocol/sdk";

import { createRemoteAcpAgent } from "../integrations/remote-acp/agent.js";
import { HttpRemoteEngine } from "../integrations/remote-acp/engine.js";

interface CliArgs {
  readonly url?: string;
  readonly cwd?: string;
  readonly username?: string;
  readonly password?: string;
  readonly help: boolean;
}

const USAGE = [
  "workflow-acp-remote — ACP bridge to a remote OpenCode server",
  "",
  "Options:",
  "  --url <url>        OpenCode server base URL (env OPENCODE_SERVER_URL)",
  "  --cwd <dir>        workspace directory sent as the routing query",
  "  --username <name>  basic-auth username (env OPENCODE_SERVER_USERNAME)",
  "  --password <pass>  basic-auth password (env OPENCODE_SERVER_PASSWORD)",
  "  --help             print this help",
].join("\n");

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: { url?: string; cwd?: string; username?: string; password?: string; help: boolean } = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { ...out, help: true };
    if (argument === "--url" || argument === "--base-url" || argument === "--cwd" || argument === "--username" || argument === "--password") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
      if (argument === "--url" || argument === "--base-url") out.url = value;
      else if (argument === "--cwd") out.cwd = value;
      else if (argument === "--username") out.username = value;
      else out.password = value;
      index += 1;
      continue;
    }
    throw new TypeError(`unknown argument: ${argument}`);
  }
  return { ...out, help: false };
}

const cwdParam = (cwd: string | null | undefined): { readonly cwd?: string } => (cwd === undefined || cwd === null ? {} : { cwd });

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const url = args.url ?? process.env.OPENCODE_SERVER_URL;
  if (url === undefined || url === "") {
    throw new TypeError("a remote server URL is required (--url or OPENCODE_SERVER_URL)");
  }
  const cwd = args.cwd ?? process.cwd();
  const username = args.username ?? process.env.OPENCODE_SERVER_USERNAME;
  const password = args.password ?? process.env.OPENCODE_SERVER_PASSWORD;
  const engine = new HttpRemoteEngine({
    baseUrl: url,
    cwd,
    ...(username === undefined || username === "" ? {} : { username }),
    ...(password === undefined || password === "" ? {} : { password }),
  });

  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    },
  });
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on("end", () => controller.close());
      process.stdin.on("error", (error) => controller.error(error));
    },
  });
  const stream = ndJsonStream(input, output);

  new AgentSideConnection((connection) => {
    const agent = createRemoteAcpAgent({
      engine,
      cwd,
      connection,
      onError: (error: unknown) => process.stderr.write(`[workflow-acp-remote] ${error instanceof Error ? error.message : String(error)}\n`),
    });
    return {
      initialize: async () => agent.initialize(),
      authenticate: async () => {
        await agent.authenticate();
      },
      newSession: async (params: NewSessionRequest) => {
        const result = await agent.newSession(cwdParam(params.cwd));
        return { sessionId: result.sessionId, configOptions: result.configOptions } as unknown as NewSessionResponse;
      },
      loadSession: async (params: LoadSessionRequest) => {
        const result = await agent.loadSession({ sessionId: params.sessionId, ...cwdParam(params.cwd) });
        return { configOptions: result.configOptions } as unknown as LoadSessionResponse;
      },
      resumeSession: async (params: ResumeSessionRequest) => {
        const result = await agent.resumeSession({ sessionId: params.sessionId, ...cwdParam(params.cwd) });
        return { configOptions: result.configOptions } as unknown as ResumeSessionResponse;
      },
      listSessions: async (params: ListSessionsRequest) => {
        const result = await agent.listSessions(cwdParam(params.cwd));
        return { sessions: result.sessions } as unknown as ListSessionsResponse;
      },
      closeSession: async (params: CloseSessionRequest) => {
        await agent.closeSession({ sessionId: params.sessionId });
      },
      setSessionMode: async (params: SetSessionModeRequest) => {
        await agent.setSessionMode({ sessionId: params.sessionId, modeId: params.modeId });
      },
      setSessionConfigOption: async (params: SetSessionConfigOptionRequest) => {
        const result = await agent.setSessionConfigOption({ sessionId: params.sessionId, configId: params.configId, value: params.value });
        return { configOptions: result.configOptions } as unknown as SetSessionConfigOptionResponse;
      },
      prompt: async (params: PromptRequest) => {
        await agent.prompt({ sessionId: params.sessionId, prompt: params.prompt });
        return { stopReason: "end_turn" as const };
      },
      cancel: async (params: CancelNotification) => {
        await agent.cancel({ sessionId: params.sessionId });
      },
    } satisfies Agent;
  }, stream);

  process.stdin.resume();
  await new Promise<void>((resolve, reject) => {
    process.stdin.on("end", () => resolve());
    process.stdin.on("error", reject);
  });
}

const invokedDirectly = process.argv[1] !== undefined && /acp-remote\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
