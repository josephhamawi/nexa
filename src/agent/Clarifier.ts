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

/** Anything to do with the user's mail, read or written. */
const ABOUT_MAIL = /\b(mail|mails|e-?mails?|inbox|mailbox)\b/;

/**
 * Whether the request already points at one account.
 *
 * Matches loosely on purpose: "check my outlook" should resolve against an
 * account called "you@outlook.com" without the user typing the
 * whole address.
 */
export function namesAnAccount(lower: string, accounts: string[]): boolean {
  return accounts.some((account) => {
    const full = account.toLowerCase();
    if (lower.includes(full)) return true;
    return full
      .split(/[@.\s_-]+/)
      .filter((part) => part.length >= 4 && !GENERIC_ACCOUNT_WORDS.has(part))
      .some((part) => new RegExp(`\\b${part}\\b`).test(lower));
  });
}

/** Parts of an address that identify a provider, not an account. */
const GENERIC_ACCOUNT_WORDS = new Set(['mail', 'email', 'inbox', 'com', 'net', 'org', 'co', 'uk']);

/** Phrases that mean "stop asking and go". */
const IMPATIENCE = /\b(just do it|go ahead|whatever|you decide|your call|any(thing)? is fine|don'?t ask|surprise me)\b/i;

export class Clarifier {
  constructor(private readonly llm: LlmProvider) {}

  /**
   * Rule-based vagueness checks, run before any model call.
   *
   * These catch the common shapes cheaply and work with no provider at all.
   */
  assessWithRules(request: string, profile: UserProfile, mailAccounts: string[] = []): ClarityAssessment {
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

    // Mail, with more than one account and nothing saying which.
    //
    // This is the question worth asking: four inboxes answer "what came in
    // today" four different ways, and reading the wrong one looks exactly like
    // a working answer. Only reached when no default account is configured --
    // the agent passes an empty list once one is set.
    if (mailAccounts.length > 1 && ABOUT_MAIL.test(lower) && !namesAnAccount(lower, mailAccounts)) {
      questions.push({
        id: 'mail_account',
        question: 'Which mail account?',
        why: `You have ${mailAccounts.length} set up, and they hold different mail.`,
        suggestions: [...mailAccounts.slice(0, 4), 'all of them'],
      });
    }

    // A bare instruction with no object: "research", "find something".
    // "check my mail" is three words and a verb, but it is not vague: it names
    // a thing Nexa can actually open. Asking "what should I look into" there
    // reads as Nexa not knowing its own capabilities.
    const bareVerb = /^(research|find|search|look|check|get|analyse|analyze|summari[sz]e)\b/.test(lower);
    if (bareVerb && words.length <= 3 && !ABOUT_MAIL.test(lower)) {
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
  async assess(
    request: string,
    profile: UserProfile,
    mailAccounts: string[] = [],
  ): Promise<ClarityAssessment> {
    const rules = this.assessWithRules(request, profile, mailAccounts);
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
