import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import { extractJson, type LlmProvider } from '../llm/LLMProvider';
import type { UserProfile } from '../config/schema';
import { childLogger } from '../logging/logger';

const log = childLogger('tool:analysis');

const InputSchema = z.object({
  /** What to do with the material: rank, summarise, compare, extract. */
  instruction: z.string().min(3),
  /** Step whose output feeds this one. Defaults to the previous step. */
  fromStep: z.string().optional(),
  /** Cap on how many items to return. */
  limit: z.number().int().min(1).max(50).default(10),
  /** Weigh results against the user profile (job hunting, learning, …). */
  useProfile: z.boolean().default(false),
});

type Input = z.infer<typeof InputSchema>;

export interface AnalyzedItem {
  title: string;
  url?: string;
  summary: string;
  /** 0-100. Higher means a better match for the instruction. */
  score: number;
  reason?: string;
}

/**
 * Turns raw collected material into a ranked, readable answer.
 *
 * With a model configured this is genuine analysis. Without one it falls back
 * to keyword scoring, which is weaker but honest: results are still real, and
 * the summary says which mode produced them.
 */
export class AnalysisTool implements Tool<Input> {
  readonly name = 'analyze';
  readonly description =
    'Analyse, rank, filter or summarise material gathered by earlier steps. Input: {instruction, limit, useProfile}.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.READ];
  readonly mutating = false;

  constructor(
    private readonly llm: LlmProvider,
    private readonly profile: () => UserProfile,
  ) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const material = collectMaterial(context.task, input.fromStep);
    if (material.length === 0) {
      return { ok: false, summary: 'Nothing to analyse: no earlier step produced material', error: 'no input material' };
    }

    context.report(`Analyzing ${material.length} items`);

    if (this.llm.available) {
      try {
        const items = await this.analyzeWithModel(input, material);
        if (items.length > 0) {
          const payload = items.slice(0, input.limit);
          return {
            ok: true,
            summary: `${payload.length} relevant result${payload.length === 1 ? '' : 's'} identified`,
            data: { items: payload, method: 'model' },
          };
        }
      } catch (err) {
        // A model failure degrades the answer; it must not lose the task.
        log.warn({ err: (err as Error).message }, 'model analysis failed, using keyword scoring');
      }
    }

    const items = this.analyzeWithKeywords(input, material).slice(0, input.limit);
    return {
      ok: true,
      summary: `${items.length} result${items.length === 1 ? '' : 's'} ranked by keyword relevance`,
      data: { items, method: 'keyword' },
    };
  }

  private async analyzeWithModel(input: Input, material: MaterialItem[]): Promise<AnalyzedItem[]> {
    const profile = input.useProfile ? this.profile() : null;
    const profileBlock = profile
      ? `\nThe user's profile:\n${JSON.stringify(
          {
            summary: profile.summary,
            skills: profile.skills,
            technologies: profile.technologies,
            preferredRoles: profile.preferredRoles,
            excludedRoles: profile.excludedRoles,
            remotePreference: profile.remotePreference,
            salaryMin: profile.salaryMin,
            locations: profile.locations,
          },
          null,
          2,
        )}\n`
      : '';

    const corpus = material
      .map((item, index) => `[${index + 1}] ${item.title}\nURL: ${item.url ?? 'n/a'}\n${item.text.slice(0, 1800)}`)
      .join('\n\n---\n\n');

    const result = await this.llm.complete({
      json: true,
      messages: [
        {
          role: 'system',
          content:
            'You analyse collected web material for an operations agent. ' +
            'Judge only what the material actually says; never invent facts, URLs or figures. ' +
            'If the material does not support a claim, leave it out. ' +
            'Reply with JSON only: {"items":[{"title","url","summary","score","reason"}]}. ' +
            'score is 0-100 for how well the item satisfies the instruction.',
        },
        {
          role: 'user',
          content: `Instruction: ${input.instruction}\n${profileBlock}\nMaterial:\n\n${corpus}`,
        },
      ],
    });

    const parsed = extractJson<{ items?: AnalyzedItem[] }>(result.text);
    const items = parsed?.items ?? [];
    return items
      .filter((item) => item && typeof item.title === 'string')
      .map((item) => ({
        title: item.title,
        url: item.url,
        summary: String(item.summary ?? '').slice(0, 600),
        score: clamp(Number(item.score ?? 0)),
        reason: item.reason ? String(item.reason).slice(0, 300) : undefined,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /** No model: score on term overlap between the instruction and the text. */
  private analyzeWithKeywords(input: Input, material: MaterialItem[]): AnalyzedItem[] {
    const profile = input.useProfile ? this.profile() : null;
    const terms = [
      ...tokenize(input.instruction),
      ...(profile ? [...profile.skills, ...profile.technologies, ...profile.preferredRoles] : []).flatMap(tokenize),
    ];
    const excluded = profile ? profile.excludedRoles.flatMap(tokenize) : [];
    const unique = [...new Set(terms)].filter((term) => term.length > 2);

    return material
      .map((item) => {
        const haystack = `${item.title} ${item.text}`.toLowerCase();
        const hits = unique.filter((term) => haystack.includes(term));
        const penalties = excluded.filter((term) => haystack.includes(term)).length;
        const score = clamp(Math.round((hits.length / Math.max(1, unique.length)) * 100) - penalties * 15);
        return {
          title: item.title,
          url: item.url,
          summary: item.text.slice(0, 300).replace(/\s+/g, ' ').trim(),
          score,
          reason: hits.length ? `matched: ${hits.slice(0, 6).join(', ')}` : 'no strong keyword match',
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}

interface MaterialItem {
  title: string;
  url?: string;
  text: string;
}

/** Pulls usable material out of whatever earlier steps produced. */
function collectMaterial(task: { steps: { id: string; status: string; output?: unknown }[] }, fromStep?: string): MaterialItem[] {
  const steps = fromStep
    ? task.steps.filter((step) => step.id === fromStep)
    : task.steps.filter((step) => step.status === 'DONE');

  const material: MaterialItem[] = [];
  for (const step of steps) {
    const output = step.output as
      | { findings?: { title: string; url: string; excerpt: string }[]; items?: unknown[]; text?: string; extracted?: unknown }
      | undefined;
    if (!output) continue;

    for (const finding of output.findings ?? []) {
      material.push({ title: finding.title, url: finding.url, text: finding.excerpt });
    }
    if (typeof output.text === 'string' && output.text.trim()) {
      material.push({ title: 'Page content', text: output.text });
    }
    if (Array.isArray(output.items)) {
      for (const item of output.items) {
        if (typeof item === 'string') material.push({ title: item.slice(0, 80), text: item });
        else if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          material.push({
            title: String(record.title ?? record.name ?? 'Item'),
            url: typeof record.url === 'string' ? record.url : undefined,
            text: JSON.stringify(record).slice(0, 2000),
          });
        }
      }
    }
  }
  return material;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(Boolean);
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
