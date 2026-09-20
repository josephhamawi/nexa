import type { Task } from '../tasks/Task';

/**
 * How much a result deserves to be trusted.
 *
 * A number on its own invites false precision, so every score comes with the
 * factors that produced it. The user can then see *why* something scored 45
 * rather than being asked to take it on faith.
 */

export interface ConfidenceFactor {
  label: string;
  /** Signed contribution, for display. */
  delta: number;
}

export interface Confidence {
  /** 0-100. */
  score: number;
  level: 'high' | 'medium' | 'low' | 'none';
  /** One line suitable for a report or a tooltip. */
  summary: string;
  factors: ConfidenceFactor[];
}

const BASE = 50;

/**
 * Scores a finished task.
 *
 * Deliberately conservative: analysis without a model, few sources, retries and
 * weak relevance all pull it down, because those are exactly the situations
 * where a confident-sounding answer is most likely to be wrong.
 */
export function computeConfidence(task: Task): Confidence {
  const factors: ConfidenceFactor[] = [];
  let score = BASE;

  const add = (label: string, delta: number): void => {
    if (delta === 0) return;
    factors.push({ label, delta });
    score += delta;
  };

  const outputs = task.steps.filter((step) => step.status === 'DONE').map((step) => step.output);

  // Simulated work is not evidence of anything.
  const simulated = outputs.some((output) => (output as { simulated?: boolean } | undefined)?.simulated);
  if (simulated) {
    return {
      score: 0,
      level: 'none',
      summary: 'Demo mode: these results are simulated, not collected.',
      factors: [{ label: 'demo mode', delta: -BASE }],
    };
  }

  // How the material was judged.
  const method = outputs
    .map((output) => (output as { method?: string } | undefined)?.method)
    .find(Boolean);
  if (method === 'model') add('analysed by the model', 12);
  else if (method === 'keyword') add('keyword matching only, no model', -18);

  // How much was actually read.
  const sources = outputs.reduce<number>((total, output) => {
    const findings = (output as { findings?: unknown[] } | undefined)?.findings;
    return total + (Array.isArray(findings) ? findings.length : 0);
  }, 0);
  if (sources >= 4) add(`${sources} sources read`, 14);
  else if (sources >= 2) add(`${sources} sources read`, 6);
  else if (sources === 1) add('only 1 source read', -8);
  else add('no sources read', -20);

  // How well the best result matched.
  const items = outputs
    .map((output) => (output as { items?: { score?: number }[] } | undefined)?.items)
    .find((value) => Array.isArray(value) && value.length > 0) as { score?: number }[] | undefined;

  if (items && items.length > 0) {
    const best = Math.max(...items.map((item) => item.score ?? 0));
    if (best >= 70) add('strong match to the request', 14);
    else if (best >= 40) add('moderate match to the request', 4);
    else add('weak match to the request', -20);
  } else {
    add('nothing matched', -25);
  }

  // Evidence you can check yourself.
  const checkable = task.evidence.filter((item) => item.url || item.path).length;
  if (checkable >= 3) add(`${checkable} pieces of evidence`, 8);
  else if (checkable === 0) add('no evidence captured', -10);

  // Trouble along the way.
  const retries = task.steps.reduce((total, step) => total + Math.max(0, step.attempts - 1), 0);
  if (retries > 0) add(`${retries} retry(ies) needed`, -retries * 5);

  const failed = task.steps.filter((step) => step.status === 'FAILED').length;
  if (failed > 0) add(`${failed} step(s) failed`, -failed * 15);

  // The plan had to be extended, so the first attempt fell short.
  const adaptive = task.steps.length - task.plannedStepCount;
  if (adaptive > 0) add('plan needed extending', -5);

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';

  return { score, level, summary: describe(score, level, factors), factors };
}

function describe(score: number, level: Confidence['level'], factors: ConfidenceFactor[]): string {
  const positives = factors.filter((f) => f.delta > 0).map((f) => f.label);
  const negatives = factors.filter((f) => f.delta < 0).map((f) => f.label);

  const parts = [`${score}% confidence (${level})`];
  if (positives.length > 0) parts.push(`based on ${positives.join(', ')}`);
  if (negatives.length > 0) parts.push(`held back by ${negatives.join(', ')}`);

  return parts.join('; ');
}

/** Short label for a compact UI, e.g. a task card. */
export function confidenceLabel(confidence: Confidence): string {
  if (confidence.level === 'none') return 'simulated';
  return `${confidence.score}%`;
}
