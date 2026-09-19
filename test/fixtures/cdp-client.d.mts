export interface CdpClient {
  readonly sessionId: string;
  readonly consoleErrors: string[];
  readonly exceptions: string[];
  evaluate(expression: string): Promise<unknown>;
  waitFor(expression: string, timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export function connectCdp(browserWsUrl: string, url: string): Promise<CdpClient>;
export function findChromeExecutable(): string | null;
