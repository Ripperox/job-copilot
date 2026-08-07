import { describe, it, expect } from 'vitest';
import { heuristicScore } from '../src/scoring';
import { Job, Profile } from '../src/types';

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j:1', source: 'test', title: 'Backend Engineer', company: 'Acme',
  location: 'Mumbai, India', description: 'Node.js and Postgres.', url: 'u',
  salary: null, postedAt: null, createdAt: '2026-08-07T00:00:00.000Z', ...over,
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  resumeText: 'Backend engineer. Node, Postgres, TypeScript.',
  roles: ['backend engineer', 'full stack'],
  locations: ['mumbai', 'remote'],
  salaryFloorLPA: null, maxYoE: 3,
  mustHaves: ['node', 'postgres'],
  cvVariants: ['Backend', 'AI', 'Blockchain'], ...over,
});

describe('heuristic scoring', () => {
  // The bug this whole rewrite exists for. Two profile terms appearing anywhere
  // in a long description used to score the job 100, putting keyword artefacts
  // at the very top of the user's list, above every genuinely-read role.
  it('never returns 100 from keyword overlap alone', () => {
    const perfect = job({
      title: 'Backend Engineer',
      description: 'We use node and postgres. '.repeat(40),
    });
    const r = heuristicScore(perfect, profile());
    expect(r.score).toBeLessThanOrEqual(68);
    expect(r.score).toBeLessThan(80); // below the LLM's "apply" band, always
  });

  // The other half of the same bug: no literal substring meant a flat zero, and
  // 87% of the live pool sat there — below the UI's floor of 50, invisible.
  it('does not bottom out at zero for a plausible role', () => {
    const r = heuristicScore(
      job({ title: 'Software Developer', description: 'Build web services.' }),
      profile(),
    );
    expect(r.score).toBeGreaterThan(0);
  });

  it('scores a title match well above a body-only mention', () => {
    const inTitle = heuristicScore(job({ title: 'Backend Engineer' }), profile());
    const inBody = heuristicScore(
      job({ title: 'Software Developer', description: 'Work with our backend engineer team.' }),
      profile(),
    );
    expect(inTitle.score).toBeGreaterThan(inBody.score);
  });

  // `includes()` matched "go" inside "django" and "category".
  it('matches whole words, not substrings', () => {
    const p = profile({ roles: ['go'], mustHaves: [] });
    const django = heuristicScore(
      job({ title: 'Python Developer', description: 'Django and category pages.' }), p,
    );
    const real = heuristicScore(
      job({ title: 'Go Developer', description: 'We write Go.' }), p,
    );
    expect(real.score).toBeGreaterThan(django.score);
  });

  // Profile terms are user input; "c++" and "node.js" must not blow up the regex
  // or silently match nothing.
  it('handles terms containing regex metacharacters', () => {
    const p = profile({ roles: [], mustHaves: ['c++', 'node.js'] });
    expect(() => heuristicScore(job(), p)).not.toThrow();
    const hit = heuristicScore(
      job({ title: 'Engineer', description: 'Strong c++ and node.js required.' }), p,
    );
    const miss = heuristicScore(
      job({ title: 'Engineer', description: 'Strong Java required.' }), p,
    );
    expect(hit.score).toBeGreaterThan(miss.score);
  });

  it('credits a location match and, failing that, remote', () => {
    const base = job({ title: 'Developer', location: 'Berlin, Germany', description: 'On site.' });
    const local = heuristicScore(job({ title: 'Developer', location: 'Mumbai, India' }), profile());
    const remote = heuristicScore(
      job({ title: 'Developer', location: 'Anywhere', description: 'Fully remote role.' }), profile(),
    );
    const neither = heuristicScore(base, profile());
    expect(local.score).toBeGreaterThan(neither.score);
    expect(remote.score).toBeGreaterThan(neither.score);
  });

  it('says plainly that no model read the job', () => {
    const r = heuristicScore(job(), profile());
    expect(r.reason).toMatch(/not read by a model/i);
    // And no longer leaks the old "matched 2/2 of your key terms" framing, which
    // read like a confident verdict.
    expect(r.reason).not.toMatch(/^Heuristic:/);
  });

  it('still picks a CV variant from the job content', () => {
    const ai = heuristicScore(
      job({ title: 'ML Engineer', description: 'LLM and machine learning work.' }), profile(),
    );
    expect(ai.cvVariant).toBe('AI');
    const chain = heuristicScore(
      job({ title: 'Engineer', description: 'Solidity and smart contract work.' }), profile(),
    );
    expect(chain.cvVariant).toBe('Blockchain');
  });

  it('degrades safely with an empty profile', () => {
    const p = profile({ roles: [], mustHaves: [], locations: [], cvVariants: [] });
    const r = heuristicScore(job(), p);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(68);
    expect(r.cvVariant).toBe('Default');
  });

  // The old scorer had exactly three reachable values on the live pool — 0, 50
  // and 100 — which is not a ranking, it's three buckets. These four jobs are
  // deliberately ordered best to worst, and each must score strictly below the
  // one above it.
  it('ranks jobs monotonically instead of bucketing them', () => {
    const ranked = [
      job({ title: 'Backend Engineer', location: 'Mumbai, India', description: 'node and postgres' }),
      job({ title: 'Backend Engineer', location: 'Berlin, Germany', description: 'on site, java shop' }),
      job({ title: 'Software Developer', location: 'Remote', description: 'we use node here' }),
      job({ title: 'Marketing Manager', location: 'Berlin, Germany', description: 'run campaigns' }),
    ];
    const scores = ranked.map((j) => heuristicScore(j, profile()).score);
    expect(new Set(scores).size).toBe(4);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  // A posting literally called "Backend Engineer" must never be hidden from
  // someone who asked for backend engineer roles, whatever else fails to match.
  it('puts a title match above the UI score floor on its own', () => {
    const r = heuristicScore(
      job({ title: 'Backend Engineer', location: 'Berlin, Germany', description: 'A Java shop.' }),
      profile(),
    );
    expect(r.score).toBeGreaterThanOrEqual(50);
  });
});
