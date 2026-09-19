import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { LlmProvider } from '../llm/LLMProvider';
import { childLogger } from '../logging/logger';
import { sleep } from '../utils/time';

const log = childLogger('tool:research');

const InputSchema = z.object({
  query: z.string().min(2),
  /** How many result pages to actually open and read. */
  depth: z.number().int().min(1).max(8).default(4),
  /** Extra terms a result must mention to be worth reading. */
  mustInclude: z.array(z.string()).default([]),
});

type Input = z.infer<typeof InputSchema>;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchFinding extends SearchHit {
  /** First few thousand characters of readable page text. */
  excerpt: string;
  fetchedAt: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Researches a question against the public web.
 *
 * Search goes through DuckDuckGo's HTML endpoint, which needs no API key, and
 * pages are fetched politely one at a time. Nothing here logs in anywhere or
 * touches a paywall; if a page refuses a plain fetch, it is reported as
 * unreadable rather than worked around.
 */
export class WebResearchTool implements Tool<Input> {
  readonly name = 'web_research';
  readonly description =
    'Search the public web for a question and read the most relevant pages. Input: {query, depth, mustInclude}.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.RESEARCH];
  readonly mutating = false;

  constructor(private readonly llm: LlmProvider, private readonly demoMode: () => boolean) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    if (this.demoMode()) return this.demoResult(input, context);

    context.report(`Searching for "${input.query}"`);

    let hits: SearchHit[];
    try {
      hits = await search(input.query);
    } catch (err) {
      return {
        ok: false,
        summary: 'Web search failed',
        error: (err as Error).message,
      };
    }

    const filtered = input.mustInclude.length
      ? hits.filter((hit) =>
          input.mustInclude.some((term) =>
            `${hit.title} ${hit.snippet}`.toLowerCase().includes(term.toLowerCase()),
          ),
        )
      : hits;

    const shortlist = (filtered.length > 0 ? filtered : hits).slice(0, input.depth);
    if (shortlist.length === 0) {
      return { ok: true, summary: 'No search results came back for that query', data: { findings: [] } };
    }

    context.report(`Reading ${shortlist.length} of ${hits.length} sources`);

    const findings: ResearchFinding[] = [];
    for (const hit of shortlist) {
      if (context.signal?.aborted) break;
      const excerpt = await readPage(hit.url);
      if (!excerpt) {
        log.debug({ url: hit.url }, 'page could not be read');
        continue;
      }
      const finding: ResearchFinding = { ...hit, excerpt, fetchedAt: new Date().toISOString() };
      findings.push(finding);
      context.addEvidence({
        kind: 'page',
        url: hit.url,
        title: hit.title,
        summary: hit.snippet.slice(0, 200),
      });
      // One page at a time, with a pause. Politeness, not evasion.
      await sleep(600);
    }

    if (findings.length === 0) {
      return {
        ok: false,
        summary: `Found ${hits.length} results but none could be read`,
        error: 'every candidate page refused a plain fetch',
      };
    }

    context.report(`Read ${findings.length} sources`);
    return {
      ok: true,
      summary: `Researched "${input.query}" across ${findings.length} sources`,
      data: { query: input.query, findings },
    };
  }

  private async demoResult(input: Input, context: ToolContext): Promise<ToolResult> {
    context.report(`[demo] Simulating a search for "${input.query}"`);
    await sleep(700);
    const findings: ResearchFinding[] = [1, 2, 3].map((n) => ({
      title: `[SIMULATED] Result ${n} for ${input.query}`,
      url: `https://example.com/demo/${n}`,
      snippet: 'Demo mode: this result is generated locally and was not fetched from the web.',
      excerpt: `Demo mode placeholder content for "${input.query}". No network request was made.`,
      fetchedAt: new Date().toISOString(),
    }));
    return {
      ok: true,
      summary: `[demo] Simulated research across ${findings.length} sources`,
      data: { query: input.query, findings, simulated: true },
    };
  }
}

/** DuckDuckGo's HTML endpoint: no key, no account, no terms-of-service games. */
export async function search(query: string, limit = 12): Promise<SearchHit[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`search returned HTTP ${response.status}`);
    return parseSearchResults(await response.text()).slice(0, limit);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseSearchResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchor = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippet = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const snippets: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = snippet.exec(html)) !== null) snippets.push(stripTags(match[1] ?? ''));

  let index = 0;
  while ((match = anchor.exec(html)) !== null) {
    const href = decodeRedirect(match[1] ?? '');
    const title = stripTags(match[2] ?? '');
    if (!href || !title) continue;
    hits.push({ url: href, title, snippet: snippets[index] ?? '' });
    index += 1;
  }
  return hits;
}

/** DuckDuckGo wraps results in /l/?uddg=<encoded target>. */
function decodeRedirect(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/);
  const raw = match ? decodeURIComponent(match[1] as string) : href;
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw.startsWith('http') ? raw : '';
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetches a page and reduces it to readable text. Returns null if unreadable. */
export async function readPage(url: string, maxChars = 6000): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('html') && !type.includes('text')) return null;
    return htmlToText(await response.text()).slice(0, maxChars);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 200_000);
}
