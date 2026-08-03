import { describe, it, expect, afterAll } from 'vitest';
import { parseBatchResponse, scoreJobsBatched } from '../src/batch-scoring';
import { closePool } from '../src/db/pool';
import { config } from '../src/config';
import { Job, Profile } from '../src/types';

afterAll(closePool);

const profile: Profile = {
  resumeText: 'Backend engineer. Node.js, TypeScript, PostgreSQL.',
  roles: ['Backend Engineer'],
  locations: ['Remote'],
  salaryFloorLPA: null,
  maxYoE: 3,
  mustHaves: ['Node', 'SQL'],
  cvVariants: ['Backend', 'AI', 'Blockchain'],
};

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  source: 'test',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'Node.js and PostgreSQL APIs. 1-3 years experience.',
  url: 'u',
  salary: null,
  postedAt: null,
  createdAt: '2026-08-02T00:00:00.000Z',
  ...over,
});

// A config with no provider keys at all — forces the heuristic path so these
// tests never make a network call.
const NO_LLM = { ...config, geminiApiKey: '', groqApiKey: '', anthropicApiKey: '' };

describe('parseBatchResponse', () => {
  it('parses a clean array', () => {
    const r = parseBatchResponse(
      '[{"id":"a:1","score":85,"reason":"good","cvVariant":"Backend"}]',
      profile,
    );
    expect(r.get('a:1')).toEqual({ score: 85, reason: 'good', cvVariant: 'Backend' });
  });

  it('ignores prose and markdown fences around the array', () => {
    const r = parseBatchResponse(
      'Sure! Here are the scores:\n```json\n[{"id":"a:1","score":70,"reason":"ok","cvVariant":"Backend"}]\n```\nHope that helps.',
      profile,
    );
    expect(r.get('a:1')?.score).toBe(70);
  });

  it('salvages entries from a TRUNCATED array', () => {
    // The model ran out of output tokens mid-third-object.
    const truncated =
      '[{"id":"a:1","score":80,"reason":"one","cvVariant":"Backend"},' +
      '{"id":"a:2","score":60,"reason":"two","cvVariant":"Backend"},' +
      '{"id":"a:3","score":';
    const r = parseBatchResponse(truncated, profile);
    expect(r.size).toBe(2);
    expect(r.get('a:1')?.score).toBe(80);
    expect(r.get('a:2')?.score).toBe(60);
    expect(r.has('a:3')).toBe(false); // reported missing, so it gets retried
  });

  it('keys by id, so a reordered response still maps correctly', () => {
    const r = parseBatchResponse(
      '[{"id":"a:2","score":30,"reason":"b","cvVariant":"Backend"},{"id":"a:1","score":90,"reason":"a","cvVariant":"Backend"}]',
      profile,
    );
    expect(r.get('a:1')?.score).toBe(90);
    expect(r.get('a:2')?.score).toBe(30);
  });

  it('clamps out-of-range scores', () => {
    const r = parseBatchResponse(
      '[{"id":"a:1","score":150,"reason":"x","cvVariant":"Backend"},{"id":"a:2","score":-20,"reason":"y","cvVariant":"Backend"}]',
      profile,
    );
    expect(r.get('a:1')?.score).toBe(100);
    expect(r.get('a:2')?.score).toBe(0);
  });

  it('falls back to the first CV variant when the model invents one', () => {
    const r = parseBatchResponse(
      '[{"id":"a:1","score":80,"reason":"x","cvVariant":"Rustacean"}]',
      profile,
    );
    expect(r.get('a:1')?.cvVariant).toBe('Backend');
  });

  it('drops entries with no id or a non-numeric score', () => {
    const r = parseBatchResponse(
      '[{"score":80,"reason":"no id"},{"id":"a:1","score":"high"},{"id":"a:2","score":55,"reason":"ok","cvVariant":"Backend"}]',
      profile,
    );
    expect(r.size).toBe(1);
    expect(r.get('a:2')?.score).toBe(55);
  });

  it('returns an empty map for junk rather than throwing', () => {
    expect(parseBatchResponse('I cannot help with that.', profile).size).toBe(0);
    expect(parseBatchResponse('', profile).size).toBe(0);
    expect(parseBatchResponse('[[[', profile).size).toBe(0);
  });
});

describe('scoreJobsBatched', () => {
  it('returns a result for every job, even with no LLM configured', async () => {
    const jobs = [job('a:1'), job('a:2'), job('a:3')];
    const out = await scoreJobsBatched(jobs, profile, NO_LLM);
    expect(out.results.size).toBe(3);
    for (const j of jobs) expect(out.results.has(j.id)).toBe(true);
    expect(out.llmRequests).toBe(0);
  });

  it('settles senior roles with the free gate, never an LLM request', async () => {
    const jobs = [
      job('s:1', { title: 'Senior Backend Engineer' }),
      job('s:2', { title: 'Principal Engineer' }),
      job('s:3', { title: 'Engineering Manager' }),
    ];
    const out = await scoreJobsBatched(jobs, profile, NO_LLM);
    expect(out.gated).toBe(3);
    expect(out.llmRequests).toBe(0);
    for (const j of jobs) expect(out.results.get(j.id)!.score).toBeLessThan(25);
  });

  it('settles non-engineering titles with the free gate', async () => {
    const out = await scoreJobsBatched(
      [job('n:1', { title: 'Account Executive' }), job('n:2', { title: 'Customer Support Lead' })],
      profile,
      NO_LLM,
    );
    expect(out.gated).toBe(2);
    expect(out.llmRequests).toBe(0);
  });

  it('handles an empty input list', async () => {
    const out = await scoreJobsBatched([], profile, NO_LLM);
    expect(out.results.size).toBe(0);
    expect(out.llmRequests).toBe(0);
  });

  it('accounts for every job across the outcome counters', async () => {
    const jobs = [
      job('a:1'),
      job('s:1', { title: 'Senior Backend Engineer' }),
      job('n:1', { title: 'Sales Manager' }),
    ];
    const out = await scoreJobsBatched(jobs, profile, NO_LLM);
    expect(out.gated + out.batched + out.individual + out.heuristic).toBe(jobs.length);
    expect(out.results.size).toBe(jobs.length);
  });
});
