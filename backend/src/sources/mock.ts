import { Job } from '../types';

// Sample jobs so the app works end-to-end with zero API keys. A varied set
// (strong matches + clear non-matches) so scoring shows a real spread.
export function fetchMockJobs(): Job[] {
  const now = new Date().toISOString();
  const raw: Omit<Job, 'createdAt'>[] = [
    {
      id: 'mock:1',
      source: 'mock',
      title: 'Backend Engineer (Node.js)',
      company: 'Finlytics',
      location: 'Remote, India',
      description:
        'Build and scale REST APIs in Node.js/TypeScript backed by PostgreSQL. Own services end-to-end, from design to deployment on AWS. JWT auth, testing, and performance are core to the role.',
      url: 'https://example.com/jobs/backend-node',
      salary: '18–24 LPA',
      postedAt: now,
    },
    {
      id: 'mock:2',
      source: 'mock',
      title: 'Full-Stack Engineer (React + Node)',
      company: 'Careloop Health',
      location: 'Remote',
      description:
        'Full-stack role building responsive React front-ends and Node.js back-ends. Experience with REST APIs, PostgreSQL, and cloud deployment. Bonus: interest in AI/LLM product features.',
      url: 'https://example.com/jobs/fullstack',
      salary: '20–28 LPA',
      postedAt: now,
    },
    {
      id: 'mock:3',
      source: 'mock',
      title: 'AI/LLM Engineer',
      company: 'Nimbus AI',
      location: 'Bangalore / Remote',
      description:
        'Integrate LLMs into products: RAG pipelines, natural-language-to-SQL, agentic workflows. Python and TypeScript. Experience deploying open-source models a plus.',
      url: 'https://example.com/jobs/llm-engineer',
      salary: '25–35 LPA',
      postedAt: now,
    },
    {
      id: 'mock:4',
      source: 'mock',
      title: 'Blockchain Engineer (Rust/Substrate)',
      company: 'ChainForge',
      location: 'Remote',
      description:
        'Design consensus and chain infrastructure in Rust/Substrate. Web3, Solidity, and smart-contract experience valued. Real-time systems background helpful.',
      url: 'https://example.com/jobs/blockchain',
      salary: '30–45 LPA',
      postedAt: now,
    },
    {
      id: 'mock:5',
      source: 'mock',
      title: 'Senior Java Enterprise Developer',
      company: 'LegacyCorp',
      location: 'Chennai (On-site)',
      description:
        'Maintain large Java/Spring monoliths and Oracle databases in an on-site enterprise environment. 8+ years of Java required.',
      url: 'https://example.com/jobs/java-enterprise',
      salary: '15–20 LPA',
      postedAt: now,
    },
    {
      id: 'mock:6',
      source: 'mock',
      title: 'Marketing Operations Analyst',
      company: 'GrowthLabs',
      location: 'Delhi (On-site)',
      description:
        'Own marketing dashboards, campaign analytics, and CRM hygiene. Strong Excel and communication skills. No engineering required.',
      url: 'https://example.com/jobs/marketing-ops',
      salary: '8–12 LPA',
      postedAt: now,
    },
    {
      id: 'mock:7',
      source: 'mock',
      title: 'Real-Time Systems Engineer (Node.js + WebSockets)',
      company: 'Streamline',
      location: 'Remote, India',
      description:
        'Build low-latency, event-driven services powering live collaboration. Node.js/TypeScript, WebSockets, Redis pub/sub, and message queues. You care about backpressure, reconnection, and horizontal scaling.',
      url: 'https://example.com/jobs/realtime-node',
      salary: '22–30 LPA',
      postedAt: now,
    },
    {
      id: 'mock:8',
      source: 'mock',
      title: 'Backend Platform Engineer (TypeScript)',
      company: 'Ledgerly',
      location: 'Remote',
      description:
        'Design internal platform services and APIs in TypeScript on Node.js. PostgreSQL, gRPC, and Docker/Kubernetes. Strong focus on observability, testing, and reliable deployments.',
      url: 'https://example.com/jobs/platform-backend',
      salary: '20–26 LPA',
      postedAt: now,
    },
    {
      id: 'mock:9',
      source: 'mock',
      title: 'LLM Application Engineer',
      company: 'Draftwise',
      location: 'Bangalore / Remote',
      description:
        'Ship user-facing AI features: prompt engineering, tool-calling agents, and RAG over private data. TypeScript/Node back-ends with a React front-end. Evaluate and fine-tune model behaviour in production.',
      url: 'https://example.com/jobs/llm-app',
      salary: '24–34 LPA',
      postedAt: now,
    },
    {
      id: 'mock:10',
      source: 'mock',
      title: 'Sales Development Representative',
      company: 'PipelinePro',
      location: 'Gurgaon (On-site)',
      description:
        'Prospect and qualify outbound leads, book demos, and hit quarterly quotas. Excellent phone and email communication. No technical background needed; SaaS sales experience preferred.',
      url: 'https://example.com/jobs/sdr',
      salary: '6–10 LPA + commission',
      postedAt: now,
    },
    {
      id: 'mock:11',
      source: 'mock',
      title: 'Senior C++ Systems Programmer (Trading)',
      company: 'Quantis Capital',
      location: 'Mumbai (On-site)',
      description:
        'Develop ultra-low-latency trading systems in modern C++ on Linux. Lock-free data structures, kernel bypass networking, and 10+ years of C++ required. On-site only.',
      url: 'https://example.com/jobs/cpp-trading',
      salary: '40–60 LPA',
      postedAt: now,
    },
    {
      id: 'mock:12',
      source: 'mock',
      title: 'IT Support Specialist',
      company: 'OfficeStack',
      location: 'Pune (On-site)',
      description:
        'Provide desktop support, manage user accounts, and handle hardware/network tickets. Windows administration and helpdesk experience. Not a software development role.',
      url: 'https://example.com/jobs/it-support',
      salary: '4–7 LPA',
      postedAt: now,
    },
  ];
  return raw.map((j) => ({ ...j, createdAt: now }));
}
