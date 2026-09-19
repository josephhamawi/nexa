import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { NotificationManager } from '../notifications/NotificationManager';
import { extractJson, type LlmProvider } from '../llm/LLMProvider';

const InputSchema = z.object({
  /** What the report should cover. The material comes from earlier steps. */
  instruction: z.string().default('Summarise what was found'),
  title: z.string().default('Nexa report'),
  /** Send to the chat that asked, or the default chat. */
  chatId: z.string().nullable().default(null),
  includeEvidence: z.boolean().default(true),
});

type Input = z.infer<typeof InputSchema>;

interface AnalyzedItem {
  title: string;
  url?: string;
  summary: string;
  score: number;
  reason?: string;
}

/**
 * Turns a finished task into a report and delivers it.
 *
 * The report is built from what previous steps actually produced. If nothing
 * was found, it says so plainly rather than padding the message, because a
 * confident-sounding empty report is worse than none.
 */
export class NotifyTool implements Tool<Input> {
  readonly name = 'notify';
  readonly description =
    'Write a concise report from the task results and send it to Telegram and the desktop. Input: {instruction, title}.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.NOTIFY];
  readonly mutating = false;

  constructor(
    private readonly notifications: NotificationManager,
    private readonly llm: LlmProvider,
  ) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const items = collectItems(context.task);
    const body = await this.composeReport(input, items, context);

    context.report('Sending report');
    const outcome = await this.notifications.report({
      title: input.title,
      body,
      chatId: input.chatId ?? context.task.sourceChatId ?? null,
    });

    return {
      ok: true,
      summary: outcome.telegram.ok ? 'Report sent to Telegram' : 'Report ready (Telegram unavailable)',
      data: { report: body, delivered: outcome.telegram.ok, items },
    };
  }

  private async composeReport(input: Input, items: AnalyzedItem[], context: ToolContext): Promise<string> {
    if (items.length === 0) {
      const failures = context.task.errors.slice(-2).map((e) => e.message);
      return failures.length
        ? `Nothing to report for "${context.task.name}".\n\nProblems hit:\n${failures.map((f) => `- ${f}`).join('\n')}`
        : `Nothing matched for "${context.task.name}". No results were found this run.`;
    }

    const lines = items
      .slice(0, 10)
      .map((item, index) => {
        const head = `${index + 1}. ${item.title}`;
        const url = item.url ? `\n   ${item.url}` : '';
        const why = item.summary ? `\n   ${item.summary.slice(0, 220)}` : '';
        return `${head}${url}${why}`;
      })
      .join('\n\n');

    const header = `${items.length} result${items.length === 1 ? '' : 's'} for "${context.task.name}"`;

    if (!this.llm.available) return `${header}\n\n${lines}`;

    try {
      const result = await this.llm.complete({
        maxOutputTokens: 900,
        messages: [
          {
            role: 'system',
            content:
              'You write short operational reports for a busy person. Plain text, no markdown headings, ' +
              'no preamble. Lead with the single most useful finding. Never invent details that are not ' +
              'in the material. Keep it under 200 words.',
          },
          {
            role: 'user',
            content: `Instruction: ${input.instruction}\n\nResults:\n${JSON.stringify(items.slice(0, 10), null, 2)}`,
          },
        ],
      });
      const text = result.text.trim();
      return text ? `${text}\n\n${lines}` : `${header}\n\n${lines}`;
    } catch {
      // A model hiccup must not stop the report going out.
      return `${header}\n\n${lines}`;
    }
  }
}

function collectItems(task: { steps: { status: string; output?: unknown }[] }): AnalyzedItem[] {
  for (const step of [...task.steps].reverse()) {
    if (step.status !== 'DONE') continue;
    const output = step.output as { items?: AnalyzedItem[] } | undefined;
    if (output?.items && Array.isArray(output.items) && output.items.length > 0) {
      return output.items as AnalyzedItem[];
    }
  }
  return [];
}

export { extractJson };
