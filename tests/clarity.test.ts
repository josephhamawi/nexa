import { describe, expect, it } from 'vitest';
import { Clarifier } from '../src/agent/Clarifier';
import { computeConfidence } from '../src/agent/Confidence';
import { NullProvider } from '../src/llm/providers';
import { UserProfileSchema } from '../src/config/schema';
import { createTask, makeStep, TaskType, type Task } from '../src/tasks/Task';

const clarifier = new Clarifier(new NullProvider());
const emptyProfile = UserProfileSchema.parse({});

describe('asking before acting', () => {
  it('asks for a URL when told to watch something unspecified', () => {
    const result = clarifier.assessWithRules('watch this page and tell me when it changes', emptyProfile);
    expect(result.clear).toBe(false);
    expect(result.questions.some((q) => q.id === 'target')).toBe(true);
  });

  it('asks what counts as a change when the trigger is unstated', () => {
    const result = clarifier.assessWithRules('watch https://example.com', emptyProfile);
    expect(result.clear).toBe(false);
    expect(result.questions.some((q) => q.id === 'trigger')).toBe(true);
    expect(result.questions[0].suggestions.length).toBeGreaterThan(0);
  });

  it('asks which roles when hunting jobs with an empty profile', () => {
    const result = clarifier.assessWithRules('find me some jobs', emptyProfile);
    expect(result.clear).toBe(false);
    expect(result.questions.some((q) => q.id === 'role')).toBe(true);
  });

  it('does not ask when the profile already answers it', () => {
    const profile = UserProfileSchema.parse({ preferredRoles: ['AI engineer'] });
    const result = clarifier.assessWithRules('find me some jobs', profile);
    expect(result.questions.some((q) => q.id === 'role')).toBe(false);
  });

  it('asks what a bare verb refers to', () => {
    expect(clarifier.assessWithRules('research', emptyProfile).clear).toBe(false);
    expect(clarifier.assessWithRules('find something', emptyProfile).clear).toBe(false);
  });

  it('asks what a dangling pronoun means', () => {
    const result = clarifier.assessWithRules('summarise that', emptyProfile);
    expect(result.clear).toBe(false);
    expect(result.questions.some((q) => q.id === 'referent')).toBe(true);
  });

  it('leaves a specific request alone', () => {
    for (const request of [
      'research the latest AI agent frameworks and send me a summary',
      'watch https://example.com/pricing and tell me when the price changes',
      'find 5 remote AI engineer roles paying over 120k',
    ]) {
      expect(clarifier.assessWithRules(request, emptyProfile).clear, request).toBe(true);
    }
  });

  it('stops asking when told to get on with it', () => {
    const result = clarifier.assessWithRules('find me some jobs, just do it', emptyProfile);
    expect(result.clear).toBe(true);
  });

  it('never asks more than three questions at once', () => {
    const result = clarifier.assessWithRules('watch it', emptyProfile);
    expect(result.questions.length).toBeLessThanOrEqual(3);
  });

  it('folds answers back into one coherent request', () => {
    const questions = clarifier.assessWithRules('find me some jobs', emptyProfile).questions;
    const merged = clarifier.merge('find me some jobs', questions, ['AI engineer']);
    expect(merged).toContain('find me some jobs');
    expect(merged).toContain('AI engineer');
  });
});

describe('confidence scoring', () => {
  function taskWith(steps: { status: string; output?: unknown; attempts?: number }[], evidence = 0): Task {
    const base = createTask({ name: 't', naturalLanguageRequest: 'r', type: TaskType.RESEARCH });
    return {
      ...base,
      plannedStepCount: steps.length,
      steps: steps.map((step, index) => ({
        ...makeStep('tool', `step ${index}`),
        status: step.status as never,
        output: step.output,
        attempts: step.attempts ?? 1,
      })),
      evidence: Array.from({ length: evidence }, (_, i) => ({
        id: `e${i}`,
        taskId: base.id,
        stepId: null,
        at: '',
        kind: 'page' as const,
        url: `https://example.com/${i}`,
      })),
    };
  }

  it('scores a well-sourced, model-analysed result high', () => {
    const task = taskWith(
      [
        { status: 'DONE', output: { findings: [1, 2, 3, 4, 5] } },
        { status: 'DONE', output: { items: [{ score: 85 }], method: 'model' } },
      ],
      4,
    );
    const confidence = computeConfidence(task);
    expect(confidence.level).toBe('high');
    expect(confidence.score).toBeGreaterThanOrEqual(70);
    expect(confidence.summary).toMatch(/sources read/);
  });

  it('scores a thin keyword-only result low', () => {
    const task = taskWith([
      { status: 'DONE', output: { findings: [1] } },
      { status: 'DONE', output: { items: [{ score: 10 }], method: 'keyword' } },
    ]);
    const confidence = computeConfidence(task);
    expect(confidence.level).toBe('low');
    expect(confidence.summary).toMatch(/held back by/);
  });

  it('refuses to claim any confidence in simulated work', () => {
    const task = taskWith([{ status: 'DONE', output: { simulated: true, findings: [1, 2, 3] } }]);
    const confidence = computeConfidence(task);
    expect(confidence.score).toBe(0);
    expect(confidence.level).toBe('none');
    expect(confidence.summary).toMatch(/simulated/i);
  });

  it('penalises retries and failures', () => {
    const clean = computeConfidence(
      taskWith([{ status: 'DONE', output: { findings: [1, 2, 3, 4] } }, { status: 'DONE', output: { items: [{ score: 80 }], method: 'model' } }], 3),
    );
    const troubled = computeConfidence(
      taskWith(
        [
          { status: 'DONE', output: { findings: [1, 2, 3, 4] }, attempts: 3 },
          { status: 'DONE', output: { items: [{ score: 80 }], method: 'model' }, attempts: 1 },
          { status: 'FAILED' },
        ],
        3,
      ),
    );
    expect(troubled.score).toBeLessThan(clean.score);
    expect(troubled.summary).toMatch(/retry|failed/);
  });

  it('always explains itself rather than giving a bare number', () => {
    const confidence = computeConfidence(taskWith([{ status: 'DONE', output: { findings: [1, 2] } }]));
    expect(confidence.factors.length).toBeGreaterThan(0);
    expect(confidence.summary).toContain('%');
  });

  it('stays within 0 and 100 however bad things got', () => {
    const awful = computeConfidence(
      taskWith([
        { status: 'FAILED', attempts: 5 },
        { status: 'FAILED', attempts: 5 },
        { status: 'FAILED', attempts: 5 },
      ]),
    );
    expect(awful.score).toBeGreaterThanOrEqual(0);
    expect(awful.score).toBeLessThanOrEqual(100);
  });
});

describe('merged requests stay clean', () => {
  it('folds in the answer without echoing the question back', () => {
    const questions = clarifier.assessWithRules('find me some jobs', emptyProfile).questions;
    const merged = clarifier.merge('find me some jobs', questions, ['AI engineer, remote']);
    expect(merged).toBe('find me some jobs (AI engineer, remote)');
    expect(merged).not.toMatch(/What roles/);
  });

  it('leaves the request untouched when nothing was answered', () => {
    const questions = clarifier.assessWithRules('find me some jobs', emptyProfile).questions;
    expect(clarifier.merge('find me some jobs', questions, [''])).toBe('find me some jobs');
  });
});


describe('choosing between mail accounts', () => {
  const accounts = ['iCloud', 'you@outlook.com', 'you@hotmail.com'];
  const profile = UserProfileSchema.parse({});
  const clarifier = new Clarifier(new NullProvider());

  it('asks which account when several exist and none was named', () => {
    const result = clarifier.assessWithRules('check my mail for new mails today', profile, accounts);
    const question = result.questions.find((q) => q.id === 'mail_account');
    expect(question).toBeDefined();
    expect(question?.suggestions).toContain('iCloud');
    expect(question?.suggestions).toContain('all of them');
    expect(result.clear).toBe(false);
  });

  it('does not ask when the request already names one', () => {
    for (const ask of ['check my outlook mail', 'anything new in my hotmail inbox', 'read mail in iCloud']) {
      expect(clarifier.assessWithRules(ask, profile, accounts).questions.map((q) => q.id)).not.toContain(
        'mail_account',
      );
    }
  });

  it('does not ask when there is only one account, or none to offer', () => {
    expect(clarifier.assessWithRules('check my mail', profile, ['iCloud']).questions).toHaveLength(0);
    // The agent passes an empty list once a default is configured.
    expect(clarifier.assessWithRules('check my mail', profile, []).questions).toHaveLength(0);
  });

  it('does not call a short mail request vague, now that mail is a real capability', () => {
    const result = clarifier.assessWithRules('check my mail', profile, []);
    expect(result.questions.map((q) => q.id)).not.toContain('topic');
    expect(result.clear).toBe(true);
  });

  it('stays out of the way of requests that are not about mail', () => {
    const result = clarifier.assessWithRules('research remote AI jobs', profile, accounts);
    expect(result.questions.map((q) => q.id)).not.toContain('mail_account');
  });
});
