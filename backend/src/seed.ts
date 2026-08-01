import { db } from './db';
import { Profile } from './types';

// Seeds Rishit's profile into the local store. Run once with `npm run seed`.
// (When this becomes multi-tenant, this same shape becomes a per-user profile row.)

const profile: Profile = {
  resumeText: `Rishit Dhote — Full-Stack Engineer. Based in Mumbai, India. Open to remote.

SUMMARY
Full-stack engineer who ships end-to-end: React/TypeScript/Next.js on the front end, Node.js/Express REST APIs and PostgreSQL on the back end. Experience with AI/LLM products and high-concurrency real-time systems, with a focus on testing, performance, and data privacy.

EXPERIENCE
Software Developer — Apeing Labs (Remote, Nov 2025–Present)
- Built and shipped a cross-platform Prediction Market module integrating Polymarket and Kalshi via dFlow APIs and custom middleware, aggregating liquidity and syncing multi-chain odds in real time.
- Scaled real-time delivery from 89% to 99% at 1,000 concurrent users per replica; load-tested with Grafana K6 and drove the resulting refactor.
- Owned the test suite — unit, integration, and Playwright E2E — across critical flows (room join, trading terminal, live chat/polls).

Blockchain Developer — Caerulean Bytechains (Hyderabad, Apr–Nov 2025)
- Built the core backend for a SaaS platform that lets Web2 developers compose blockchains through a drag-and-drop feature builder, abstracting Substrate/Polkadot complexity into reusable modules.
- Designed and implemented custom consensus mechanisms in Rust/Substrate for scalable, interoperable chain infrastructure.

Data Engineer Intern — National Stock Exchange (Mumbai, Jan–Mar 2025)
- Migrated large-scale order data from Greenplum to Cloudera and ran EDA over billions of order records to surface trading trends.

AI Engineer Intern, LLMs — Smartavya Analytica (Pune, Jun–Jul 2024)
- Built an LLM-powered natural-language-to-SQL pipeline for the NSE: plain-English questions generate validated SQL, query live databases, and return data-grounded answers — deployed locally with open-source models to meet strict data-privacy requirements.

PROJECTS
Alpharooms — React, Next.js, Rust, WebSockets, AWS, PostgreSQL, Redis. Real-time platform with live video (AWS IVS), WebRTC voice, chat, polls, moderation, and a trading terminal — 30+ event types multiplexed over a single per-room WebSocket connection. Architected a high-concurrency Rust WebSocket service with Redis pub-sub fanout and PgBouncer-backed pooling, sustaining 1,000+ concurrent users per replica; Solana mainnet ingest via Yellowstone gRPC.
FlavourScout — Python. Exact, coupon-aware cart optimizer modeled as a multiple-choice knapsack; automated coupon-discovery pipeline that probes live checkouts to verify which codes actually reduce the bill.

EDUCATION
B.Tech, Computer Science (Blockchain Specialization) — VIT Vellore, 2021–2025, GPA 8.11/10.

SKILLS
Languages: TypeScript, JavaScript, Python, Rust, SQL.
Frontend: React, Next.js.
Backend: Node.js, Express, REST APIs, WebSockets, gRPC, Redis, PostgreSQL.
Cloud & tools: AWS, Git.
Testing: Jest, Supertest, Playwright, K6.
AI/LLM: LLM integration, natural-language-to-SQL, local open-source model deployment.
Blockchain: Substrate, Polkadot, Solidity, Ethereum.`,
  roles: ['Backend Engineer', 'Full Stack Developer', 'AI/LLM Engineer'],
  locations: ['Remote', 'India', 'Mumbai'],
  salaryFloorLPA: 12,
  maxYoE: 3,
  mustHaves: ['Node.js', 'TypeScript', 'React', 'Python', 'Rust', 'PostgreSQL'],
  cvVariants: ['Backend', 'AI', 'Blockchain'],
};

db.setProfile(profile);
console.log('Seeded profile for', 'Rishit Dhote');
console.log('  roles:', profile.roles.join(', '));
console.log('  locations:', profile.locations.join(', '));
console.log('  must-haves:', profile.mustHaves.join(', '));
console.log('  CV variants:', profile.cvVariants.join(', '));
console.log('\nStart the servers and open the dashboard — your profile is ready.');
