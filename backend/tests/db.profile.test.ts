import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../src/db';
import { closePool } from '../src/db/pool';
import { resetDb, TEST_USER_ID, OTHER_USER_ID } from './helpers/db';
import { Profile } from '../src/types';

const profile: Profile = {
  resumeText: 'Backend engineer, Node and Postgres.',
  roles: ['Backend Engineer', 'Full Stack Engineer'],
  locations: ['Bengaluru', 'Remote'],
  salaryFloorLPA: 15,
  maxYoE: 3,
  mustHaves: ['Node', 'SQL'],
  cvVariants: ['Backend', 'AI', 'Blockchain'],
};

describe('db profile', () => {
  beforeEach(resetDb);
  afterAll(closePool);

  it('returns null when no profile exists', async () => {
    expect(await db.getProfile(TEST_USER_ID)).toBeNull();
  });

  it('round-trips a saved profile', async () => {
    await db.setProfile(TEST_USER_ID, profile);
    expect(await db.getProfile(TEST_USER_ID)).toEqual(profile);
  });

  it('overwrites on second save rather than erroring', async () => {
    await db.setProfile(TEST_USER_ID, profile);
    await db.setProfile(TEST_USER_ID, { ...profile, maxYoE: 5 });
    expect((await db.getProfile(TEST_USER_ID))?.maxYoE).toBe(5);
  });

  it('handles a null salary floor and null maxYoE', async () => {
    await db.setProfile(TEST_USER_ID, { ...profile, salaryFloorLPA: null, maxYoE: null });
    const got = await db.getProfile(TEST_USER_ID);
    expect(got?.salaryFloorLPA).toBeNull();
    expect(got?.maxYoE).toBeNull();
  });

  it('keeps profiles separate per user', async () => {
    await db.setProfile(TEST_USER_ID, profile);
    expect(await db.getProfile(OTHER_USER_ID)).toBeNull();
  });
});
