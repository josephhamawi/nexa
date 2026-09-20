import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { childLogger } from '../logging/logger';

const log = childLogger('mcp');

/**
 * A minimal MCP client speaking JSON-RPC 2.0 over a server's stdio.
 *
 * This is how Nexa borrows capabilities it does not implement itself: any MCP
 * server (filesystem, git, databases, Slack, …) becomes a set of Nexa tools,
 * subject to the same permission and approval rules as the built-in ones.
 *
 * The server command comes from configuration only. Nothing the model produces
 * is ever executed as a shell command; it can only call tools a server already
 * advertises.
 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Servers may hint that a tool only reads. Absent means assume it writes. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private tools: McpToolDefinition[] = [];
  private starting: Promise<void> | null = null;

  constructor(
    readonly id: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string> = {},
    private readonly timeoutMs = 45_000,
  ) {}

  get connected(): boolean {
    return this.child !== null && !this.child.killed;
  }

  listTools(): McpToolDefinition[] {
    return [...this.tools];
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      log.info({ server: this.id, command: this.command }, 'starting MCP server');

      const child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.env },
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        // Servers log to stderr routinely; only keep it at debug level.
        log.debug({ server: this.id, message: chunk.trim().slice(0, 300) }, 'mcp stderr');
      });

      child.on('exit', (code) => {
        log.warn({ server: this.id, code }, 'MCP server exited');
        this.failAllPending(new McpError(`server "${this.id}" exited`));
        this.child = null;
      });

      child.on('error', (err) => {
        log.error({ server: this.id, err: err.message }, 'MCP server failed to start');
        this.failAllPending(new McpError(err.message));
        this.child = null;
      });

      this.child = child;

      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'nexa', version: '1.0.0' },
      });

      this.notify('notifications/initialized', {});

      const listed = (await this.request('tools/list', {})) as { tools?: McpToolDefinition[] };
      this.tools = listed?.tools ?? [];
      log.info({ server: this.id, tools: this.tools.length }, 'MCP server ready');
    })();

    try {
      await this.starting;
    } catch (err) {
      await this.disconnect();
      throw err;
    } finally {
      this.starting = null;
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.connected) await this.connect();
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: McpContent[];
      isError?: boolean;
    };
    return { content: result?.content ?? [], isError: Boolean(result?.isError) };
  }

  async disconnect(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.failAllPending(new McpError('client disconnected'));
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }

  // ------------------------------------------------------------- transport

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new McpError(`server "${this.id}" is not running`));

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`"${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Messages are newline-delimited JSON; a chunk may split one in half. */
  private onData(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onMessage(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private onMessage(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
    try {
      message = JSON.parse(line);
    } catch {
      log.debug({ server: this.id, line: line.slice(0, 200) }, 'ignored non-JSON output');
      return;
    }

    if (typeof message.id !== 'number') return; // a notification from the server

    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new McpError(message.error.message ?? `error ${message.error.code ?? ''}`));
      return;
    }
    pending.resolve(message.result);
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Flattens an MCP tool result into text Nexa can analyse and report. */
export function contentToText(content: McpContent[]): string {
  return content
    .map((block) => {
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'image') return '[image]';
      if (block.type === 'resource') return `[resource ${String(block.uri ?? '')}]`;
      return JSON.stringify(block);
    })
    .join('\n')
    .trim();
}
