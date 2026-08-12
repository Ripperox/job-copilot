// The career-page target list.
//
// These are companies whose openings are NOT reachable through the Greenhouse,
// Lever or Ashby APIs we already read — if a company is on one of those boards,
// scraping it is pure waste, so it belongs there and not here.
//
// The list is deliberately long and deliberately unvetted. The queue is what
// makes that safe: every target carries its own due_at, and one that returns
// nothing backs off exponentially (3h → 6h → 12h → 24h → 48h → 96h) while one
// that yields comes back at the base interval. So a bad entry costs a handful
// of credits once and then quietly drifts to the back, and there is no need to
// be precious about what goes in.
//
// Budget: Firecrawl free is 1,000 credits/month and one page is one credit. At
// 4 pages per run and 8 runs a day that is ~960/month, so the queue drains at
// ~32 targets/day and a full pass over this list takes roughly three days.
// Backoff means the productive ones are seen far more often than that.

export const CAREER_PAGE_TARGETS: string[] = [
  // --- measured productive (2026-08-06 yield run) ---
  'https://www.stackbinary.io/careers',
  'https://www.ycombinator.com/jobs',
  'https://unicoconnect.com/careers',
  'https://www.cashfree.com/careers/',
  'https://upstox.com/careers',
  'https://snapmint.com/careers',

  // --- Indian fintech / trading ---
  'https://www.perfios.com/careers/',
  'https://www.signzy.com/careers/',
  'https://www.m2pfintech.com/careers/',
  'https://www.kredx.com/careers/',
  'https://www.lendingkart.com/careers/',
  'https://www.moneyview.in/careers',
  'https://www.fibe.in/careers/',
  'https://www.bharatpe.com/careers',
  'https://www.mswipe.com/careers/',
  'https://www.innoviti.com/careers/',
  'https://www.idfy.com/careers/',
  'https://www.hyperverge.co/careers/',
  'https://www.digio.in/careers',
  'https://www.zoho.com/careers/',
  'https://www.indmoney.com/careers',
  'https://dhan.co/careers/',
  'https://fyers.in/careers/',
  'https://www.paytm.com/careers',
  'https://www.mobikwik.com/careers',
  'https://www.acko.com/careers/',
  'https://www.godigit.com/careers',
  'https://www.onsurity.com/careers/',
  'https://www.plumhq.com/careers',

  // --- Indian SaaS / product ---
  'https://www.chargebee.com/careers/',
  'https://www.freshworks.com/company/careers/',
  'https://www.browserstack.com/careers',
  'https://www.lambdatest.com/careers',
  'https://www.testsigma.com/careers',
  'https://www.whatfix.com/careers/',
  'https://www.icertis.com/careers/',
  'https://www.capillarytech.com/careers/',
  'https://www.leadsquared.com/careers/',
  'https://www.kaleyra.com/careers/',
  'https://netcorecloud.com/careers/',
  'https://vwo.com/careers/',
  'https://www.zenoti.com/careers',
  'https://www.darwinbox.com/careers',
  'https://www.exotel.com/careers/',
  'https://www.gupshup.io/careers',
  'https://www.haptik.ai/careers',
  'https://yellow.ai/careers/',
  'https://www.uniphore.com/careers/',
  'https://www.observe.ai/careers',
  'https://www.verloop.io/careers',
  'https://www.appsmith.com/careers',
  'https://tooljet.com/careers',
  'https://hasura.io/careers',
  'https://www.postman.com/company/careers/',
  'https://www.kissflow.com/careers/',
  'https://www.zluri.com/careers',
  'https://www.spendflo.com/careers',
  'https://www.everstage.com/careers',
  'https://www.fylehq.com/careers',
  'https://www.rocketlane.com/careers',
  'https://www.springworks.in/careers/',
  'https://atomicwork.com/careers',

  // --- Indian consumer / marketplaces / logistics ---
  'https://www.urbancompany.com/careers',
  'https://www.licious.in/careers',
  'https://blog.bigbasket.com/careers/',
  'https://www.purplle.com/careers',
  'https://mamaearth.in/careers',
  'https://www.lenskart.com/careers',
  'https://www.nykaa.com/careers',
  'https://www.delhivery.com/careers/',
  'https://shiprocket.in/careers/',
  'https://www.shadowfax.in/careers/',
  'https://porter.in/careers',
  'https://rapido.bike/careers',
  'https://www.udaan.com/careers',
  'https://www.ninjacart.in/careers/',
  'https://www.dealshare.in/careers',
  'https://www.myntra.com/careers',
  'https://www.flipkartcareers.com/',
  'https://www.practo.com/company/careers',
  'https://pharmeasy.in/careers',
  'https://www.cure.fit/careers',
  'https://www.healthifyme.com/careers',

  // --- Indian AI / data ---
  'https://www.sarvam.ai/careers',
  'https://www.krutrim.com/careers',
  'https://fractal.ai/careers/',
  'https://www.tredence.com/careers',
  'https://quantiphi.com/careers/',
  'https://www.sigmoid.com/careers/',
  'https://www.mad.co/careers',

  // Removed 2026-08-06: tailscale, planetscale, clickhouse and temporal all
  // publish to job-boards.greenhouse.io, so scraping their marketing pages
  // spent LLM tokens to reach data the Greenhouse source reads for free and
  // structurally. They are board tokens now, not scrape targets.
  //
  // --- global remote-friendly, no public ATS board we already read ---
  'https://fly.io/jobs',
  'https://www.crunchydata.com/careers',
  'https://www.timescale.com/careers',
  'https://www.cockroachlabs.com/careers/',
  'https://redis.io/careers/',
  'https://grafana.com/about/careers/',
  'https://sourcegraph.com/careers',
  'https://gitpod.io/careers',
  'https://replit.com/careers',
  'https://ngrok.com/careers',
  'https://www.svix.com/careers/',
  'https://inngest.com/careers',
  'https://www.hopsworks.ai/careers',

  // --- aggregator boards with no API, added 2026-08-11 ---
  //
  // These four answered 200 to a plain GET, so Firecrawl can read them. The
  // ones that did not are recorded in boards.ts with the reason: echojobs.io
  // and remotive.io sit behind Cloudflare (403), remotists.com does not
  // resolve, findwork.dev needs a key, and LinkedIn/Wellfound/Instahyre/
  // CutShort are auth-walled — scraping those breaks their terms and gets the
  // account banned, which costs more than the listings are worth.
  'https://nocsdegree.com/jobs/',
  'https://hasjob.co',
  'https://remote-developer-jobs.com',
  'https://hnjobs.emilburzo.com',

  // --- large enterprises with no readable API, added 2026-08-12 ---
  //
  // Requested as a batch: Cloudera, Deutsche Bank, Warner Bros, YASH, EY,
  // Oracle, Adobe. None of the seven is on Greenhouse, Lever or Ashby — all
  // three APIs were probed and every candidate token 404'd. What they run:
  //
  //   Cloudera       Workday        → sources/workday.ts  (keyless JSON, 82 posts)
  //   Oracle         Oracle RC      → sources/oracle.ts   (keyless JSON, 1,556)
  //   Adobe          Phenom         → here
  //   Warner Bros    Phenom         → here
  //   EY             SuccessFactors → here
  //   YASH           SuccessFactors → here
  //   Deutsche Bank  in-house       → here
  //
  // Cloudera and Oracle are deliberately NOT in this list: they answer with JSON
  // and no key, so scraping them would spend a credit per page to get worse data
  // than the API already returns for free.
  //
  // UPDATE 2026-08-12: Adobe and Warner Bros were HERE and have been removed.
  // Phenom's API does work — POST /widgets with ddoKey=refineSearch and
  // jobs=true, the flag that was missing on the first attempt — but every
  // applyUrl it returns points at Workday, and Phenom only carries a truncated
  // teaser where Workday has the full description. So the skin was skipped
  // entirely and the tenant read straight out of the applyUrl. Adobe, Warner
  // Bros and Cisco are all Workday tenants in workday.ts now. Worth checking
  // for any future Phenom site before spending a credit on it.
  //
  // URLs picked by what actually renders server-side, measured rather than
  // assumed: EY's India search carries 108 job titles in the raw HTML, so it
  // reads well. Deutsche Bank's renders entirely client-side — zero titles in
  // source — and is included on the strength of Firecrawl executing JS. If it
  // yields nothing, the queue's backoff retires it without help, which is what
  // that mechanism is for.
  'https://careers.ey.com/ey/search/?q=&locationsearch=India',
  'https://www.yash.com/careers/current-openings/',
  'https://careers.db.com/professionals/search-roles/',
];
