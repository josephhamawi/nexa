import { extractJson, type LlmProvider } from '../llm/LLMProvider';
import type { UserProfile } from '../config/schema';
import { childLogger } from '../logging/logger';

const log = childLogger('clarifier');

/**
 * Decides whether a request is specific enough to act on.
 *
 * The failure this prevents is the expensive one: an agent that takes "find me
 * some jobs" literally, burns ten minutes and a browser session, and returns
 * something nobody wanted. One question up front is cheaper than a wrong task.
 */

export interface ClarifyingQuestion {
  id: string;
  question: string;
  /** Why Nexa needs it, so the question does not feel like an obstacle. */
  why: string;
  /** Tappable answers, when there is a sensible shortlist. */
  suggestions: string[];
}

export interface ClarityAssessment {
  clear: boolean;
  /** 0-100: how confident the planner is that it understood the request. */
  confidence: number;
  questions: ClarifyingQuestion[];
  /** What Nexa believes it was asked to do, echoed back for confirmation. */
  interpretation: string;
}

/** Phrases that mean "stop asking and go". */
const IMPATIENCE = /\b(just do it|go ahead|whatever|you decide|your call|any(thing)? is fine|don'?t ask|surprise me)\b/i;

export class Clarifier {
  constructor(private readonly llm: LlmProvider) {}

  /**
   * Rule-based vagueness checks, run before any model call.
   *
   * These catch the common shapes cheaply and work with no provider at all.
   */
  assessWithRules(request: string, profile: UserProfile): ClarityAssessment {
    const text = request.trim();
    const lower = text.toLowerCase();
    const words = text.split(/\s+/).filter(Boolean);
    const questions: ClarifyingQuestion[] = [];

    if (IMPATIENCE.test(lower)) {
      return { clear: true, confidence: 60, questions: [], interpretation: text };
    }

    const wantsWatch = /\b(watch|monitor|keep an eye|notify me when|tell me when|alert me when)\b/.test(lower);
    const wantsJobs = /\b(job|jobs|role|roles|position|vacanc|hiring|opening)\b/.test(lower);
    const hasUrl = /https?:\/\/|\b([a-z0-9-]+\.)+[a-z]{2,}\b/i.test(text);

    // "watch this" with nothing to watch.
    if (wantsWatch && !hasUrl) {
      questions.push({
        id: 'target',
        question: 'Which page should I watch? Paste the URL.',
        why: 'A watcher needs an exact address to check.',
        suggestions: [],
      });
    }

    // A watcher with no notion of what counts as a change.
    if (wantsWatch && hasUrl && !/\b(when|if|change|price|new|available|update|drop)\b/.test(lower)) {
      questions.push({
        id: 'trigger',
        question: 'What kind of change should I tell you about?',
        why: 'Pages change constantly; this keeps the alerts worth reading.',
        suggestions: ['any content change', 'price changes', 'new items listed'],
      });
    }

    // Job hunting with no role and nothing in the profile to fall back on.
    if (wantsJobs && profile.preferredRoles.length === 0 && !/\b(engineer|developer|designer|manager|analyst|scientist|lead|architect)\b/.test(lower)) {
      questions.push({
        id: 'role',
        question: 'What roles should I look for?',
        why: 'Without this I would be guessing at your field.',
        suggestions: ['AI engineer', 'software engineer', 'data scientist'],
      });
    }

    // A bare instruction with no object: "research", "find something".
    const bareVerb = /^(research|find|search|look|check|get|analyse|analyze|summari[sz]e)\b/.test(lower);
    if (bareVerb && words.length <= 3) {
      questions.push({
        id: 'topic',
        question: 'What should I look into, specifically?',
        why: 'The request is a verb without a subject.',
        suggestions: [],
      });
    }

    // Pronouns with no antecedent: "watch it", "summarise that".
    if (/\b(it|that|this|them|those)\b/.test(lower) && !hasUrl && words.length <= 6) {
      questions.push({
        id: 'referent',
        question: 'What does that refer to?',
        why: 'I have no earlier context to resolve it against.',
        suggestions: [],
      });
    }

    const confidence = Math.max(10, 90 - questions.length * 30);
    return {
      clear: questions.length === 0,
      confidence,
      questions: questions.slice(0, 3),
      interpretation: text,
    };
  }

  /**
   * Asks the model whether anything important is missing.
   *
   * Only consulted when the rules found nothing, so a clearly-specified request
   * never pays for an extra round trip.
   */
  async assess(request: string, profile: UserProfile): Promise<ClarityAssessment> {
    const rules = this.assessWithRules(request, profile);
    if (!rules.clear || !this.llm.available) return rules;
    if (IMPATIENCE.test(request)) return rules;

    try {
      const result = await this.llm.complete({
        json: true,
        maxOutputTokens: 700,
        messages: [
          {
            role: 'system',
            content: [
              'You check whether a request to an operations agent is specific enough to act on.',
              'The agent can research the web, watch pages for changes, drive a browser, and read allowed folders.',
              '',
              'Reply with JSON only:',
              '{"clear":true,"confidence":0-100,"interpretation":"what you understand the task to be"}',
              'or',
              '{"clear":false,"confidence":0-100,"interpretation":"...","questions":[',
              '  {"id":"short_key","question":"...","why":"...","suggestions":["...","..."]}]}',
              '',
              'Ask at most two questions, and only about things that would change what the agent does.',
              'Do not ask for preferences the agent can reasonably choose itself.',
              'If the request is actionable as written, say clear:true.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Request: ${request}\n\nWhat I already know about the user:\n${JSON.stringify(
              {
                summary: profile.summary,
                preferredRoles: profile.preferredRoles,
                skills: profile.skills,
                remotePreference: profile.remotePreference,
                locations: profile.locations,
              },
              null,
              2,
            )}`,
          },
        ],
      });

      const parsed = extractJson<{
        clear?: boolean;
        confidence?: number;
        interpretation?: string;
        questions?: ClarifyingQuestion[];
      }>(result.text);

      if (!parsed) return rules;

      const questions = (parsed.questions ?? [])
        .filter((question) => question && typeof question.question === 'string')
        .slice(0, 2)
        .map((question, index) => ({
          id: question.id ?? `q${index}`,
          question: question.question,
          why: question.why ?? '',
          suggestions: Array.isArray(question.suggestions) ? question.suggestions.slice(0, 4) : [],
        }));

      return {
        clear: parsed.clear !== false && questions.length === 0,
        confidence: clamp(parsed.confidence ?? 70),
        questions,
        interpretation: parsed.interpretation ?? request,
      };
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'clarity check failed, proceeding as written');
      return rules;
    }
  }

  /**
   * Folds answers back into the original request.
   *
   * Kept as plain text rather than structured fields so the planner sees one
   * coherent instruction, exactly as if it had been phrased well first time.
   */
  merge(original: string, questions: ClarifyingQuestion[], answers: string[]): string {
    // Only the answers are folded in. Echoing the questions back would leave
    // "What roles should I look for?" sitting inside the search query.
    const given = questions
      .map((_question, index) => answers[index]?.trim())
      .filter((answer): answer is string => Boolean(answer));

    return given.length > 0 ? `${original} (${given.join('; ')})` : original;
  }
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}
