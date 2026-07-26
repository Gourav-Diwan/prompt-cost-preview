// Canned generic chat prompts used as weight-1 weak labels during training
// — REQUIRED, not decorative, in BOTH trainers (scripts/train-token-model.cjs
// via load-globals, and the Chrome extension's in-browser trainer via a
// build-time copy to extension/lib/). Plain global (var), same convention as
// heuristic.js.
//
// Why: mined session rows are all agentic:1. If they're the ONLY chat/agent
// signal in the dataset (which happened for the 2026-07-16 base weights —
// training-data.csv had lost its single_prompt rows), the `agentic` feature
// has zero variance in training, agentic:0 inference is out-of-distribution,
// and the net saturates to one constant prediction (~671k tokens) for EVERY
// chat prompt. These anchors are labeled with the CURRENT heuristic's token
// midpoint at train time (distillation), so they track heuristic changes
// automatically. No user data — all canned strings, spanning buckets
// XXS..XL and the five task types.
var SEED_PROMPTS = [
  // XXS / XS — lookups & micro-asks
  'fix typo',
  'define recursion',
  'translate hello to spanish',
  'what is a closure in javascript',
  'convert 90 fahrenheit to celsius',
  'capital of australia',
  'what does HTTP 503 mean',
  'rhyme for orange',
  // S — short tasks
  'write a thank you email to my landlord',
  'summarize the plot of hamlet in two sentences',
  'explain the difference between let and const',
  'suggest five names for a coffee shop',
  'write a haiku about winter mornings',
  'what should I ask in a phone screen for a junior developer',
  'reply to this email declining the meeting politely',
  'give me a regex that matches US zip codes',
  'explain what a 401k match means',
  'write a short toast for my sister\'s wedding',
  // M — a page of content
  'write a cover letter for a marketing manager position at a tech startup',
  'explain how DNS resolution works step by step',
  'draft an email to the team announcing our new remote work policy and what changes',
  'compare python and javascript for a beginner choosing a first language',
  'write a product description for a stainless steel water bottle aimed at hikers',
  'summarize the pros and cons of renting versus buying a home',
  'create an outline for a blog post about time management for freelancers',
  'explain the basics of how vaccines work to a ten year old',
  'write a function that debounces another function in javascript and explain it',
  'draft a polite follow up email to a client who has not paid an invoice in 30 days',
  // L — deep dives
  'write a detailed comparison of AWS, Azure, and GCP for a mid-size company migrating from on-prem, covering cost, tooling, and lock-in risk',
  'research and explain the main approaches to state management in react applications, with examples of when each is appropriate',
  'draft a comprehensive onboarding document for new engineering hires covering tools, processes, and first-week expectations',
  'analyze the tradeoffs between microservices and a monolith for a ten-person startup, and recommend one with reasoning',
  'write a detailed guide to setting up a home network with a mesh router, guest wifi, and parental controls',
  'explain transformer neural networks in depth: attention, positional encoding, and why they replaced RNNs',
  // XL — big builds/reports
  'create a complete content marketing strategy for a b2b saas company entering the project management space: audience segments, channel plan, editorial calendar themes, and success metrics for the first two quarters',
  'write a full project proposal for migrating our customer data from spreadsheets to a proper CRM, including timeline, risks, training plan, and rollback strategy',
  'design a comprehensive employee performance review system for a fifty-person company: rating framework, review cadence, calibration process, and manager guidelines',
  // creative
  'write a short story about a lighthouse keeper who discovers the light attracts more than ships',
  'compose a limerick about debugging code at midnight',
  'write the opening scene of a mystery novel set in a small mountain town',
  // code-flavored chat (still chat mode — asking, not delegating)
  'why does my useEffect run twice in development',
  'review this approach: storing user sessions in localStorage versus cookies',
  'explain the n+1 query problem and how ORMs cause it',
];
