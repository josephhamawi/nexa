import fs from 'node:fs';
import { loadEnv, paths, ensureDataDirs } from '../config/config';
import type { TelegramConfig } from '../config/schema';
import type { NexaAgent } from '../agent/NexaAgent';
import type { TelegramNotifier, TelegramUpdate } from '../notifications/TelegramNotifier';
import { childLogger } from '../logging/logger';
import { sleep } from '../utils/time';

const log = childLogger('telegram-bot');

/**
 * Telegram as a remote control for Nexa.
 *
 * Long-polls for messages, checks the sender against an allow-list, and hands
 * the text straight to the agent. Button presses (approve, resume, cancel) come
 * back through the same channel as callback queries.
 *
 * The allow-list is not optional: a bot token in the wrong hands would
 * otherwise be a remote shell over your browser and files.
 */
export class TelegramBot {
  private running = false;
  private offset = 0;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly agent: NexaAgent,
    private readonly telegram: TelegramNotifier,
    private config: TelegramConfig,
  ) {
    this.offset = this.readOffset();
  }

  updateConfig(config: TelegramConfig): void {
    this.config = config;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      log.info('telegram interface disabled in config');
      return;
    }
    if (!this.telegram.isReady()) {
      log.warn('telegram credentials missing; remote control is off');
      return;
    }

    this.running = true;
    this.agent.activity.add('Telegram control enabled', 'success');
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.telegram.getUpdates(this.offset, 25);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.updateId + 1);
          this.writeOffset();
          await this.handle(update);
        }
      } catch (err) {
        // Network blips are normal on a long poll; back off and carry on.
        log.debug({ err: (err as Error).message }, 'poll failed');
        await sleep(this.config.pollSeconds * 1000);
      }
    }
  }

  private isAuthorized(chatId: string): boolean {
    const env = loadEnv();
    const allowed = new Set([env.TELEGRAM_CHAT_ID, ...this.config.allowedChatIds].filter(Boolean) as string[]);
    return allowed.has(chatId);
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    if (!this.isAuthorized(update.chatId)) {
      log.warn({ from: update.from }, 'ignored a message from an unauthorized chat');
      // Deliberately terse: do not confirm to a stranger what this bot is.
      await this.telegram.send('Not authorized.', { chatId: update.chatId });
      return;
    }

    if (update.isCallback) {
      await this.handleCallback(update);
      return;
    }

    const text = update.text.trim();
    log.info({ from: update.from }, 'telegram request received');

    try {
      const response = await this.agent.handleRequest(text, 'telegram', update.chatId);
      await this.telegram.send(response.text, { chatId: update.chatId });
    } catch (err) {
      const message = (err as Error).message;
      log.error({ err: message }, 'request failed');
      await this.telegram.send(`That did not work: ${message}`, { chatId: update.chatId });
    }
  }

  /** Inline buttons: approve / reject / resume / open browser / cancel. */
  private async handleCallback(update: TelegramUpdate): Promise<void> {
    const [action, taskId] = update.text.split(':');
    if (!action || !taskId) return;

    let reply = '';

    switch (action) {
      case 'approve': {
        const task = this.agent.approve(taskId, true);
        reply = task ? `Approved. Continuing "${task.name}".` : 'That task is no longer waiting for approval.';
        break;
      }
      case 'reject': {
        const task = this.agent.approve(taskId, false);
        reply = task ? `Stopped "${task.name}".` : 'That task is no longer waiting for approval.';
        break;
      }
      case 'resume': {
        const task = this.agent.resumeTask(taskId);
        reply = task ? `Resuming "${task.name}".` : 'Nothing to resume there.';
        break;
      }
      case 'cancel': {
        const task = this.agent.tasks.cancel(taskId);
        reply = task ? `Cancelled "${task.name}".` : 'Nothing to cancel there.';
        break;
      }
      case 'open': {
        await this.agent.openBrowser();
        reply = 'Browser is open on this machine. Finish the step, then press Resume.';
        break;
      }
      default:
        reply = 'Unknown action.';
    }

    if (update.callbackId) await this.telegram.acknowledgeCallback(update.callbackId, reply.slice(0, 180));
    await this.telegram.send(reply, { chatId: update.chatId });
  }

  // The offset survives restarts so old commands are not replayed.
  private readOffset(): number {
    try {
      if (!fs.existsSync(paths.telegramOffsetFile)) return 0;
      const parsed = JSON.parse(fs.readFileSync(paths.telegramOffsetFile, 'utf8')) as { offset?: number };
      return typeof parsed.offset === 'number' ? parsed.offset : 0;
    } catch {
      return 0;
    }
  }

  private writeOffset(): void {
    try {
      ensureDataDirs();
      fs.writeFileSync(paths.telegramOffsetFile, JSON.stringify({ offset: this.offset }), 'utf8');
    } catch {
      // Losing the offset only risks replaying one command.
    }
  }
}
