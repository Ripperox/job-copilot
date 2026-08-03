// Runs before any test module is imported, so src/db/pool.ts reads the TEST url.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/jobcopilot_test';
