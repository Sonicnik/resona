/**
 * Fills a running backend with the demo data from the design prototype, through the real API.
 * Run against the demo data dir so it never mixes with your own data:
 *   npm run demo   # terminal 1
 *   npm run seed   # terminal 2
 * Reset: stop the backend and delete ~/.resona-demo.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.RESONA_API ?? "http://127.0.0.1:4317/api";

async function api<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(process.env.RESONA_API_TOKEN ? { Authorization: `Bearer ${process.env.RESONA_API_TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : (null as T);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const inDays = (n: number) => daysAgo(-n);

function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

const FOLDERS: Record<string, { ai: "allowed" | "denied"; files: Record<string, string> }> = {
  CubeSync: {
    ai: "allowed",
    files: {
      "README.md": `# CubeSync

Local contact deduplication across Gmail and LinkedIn exports. Identity resolution keyed on stable platform IDs instead of merging contacts by name.

People who keep contacts in several places end up with duplicates, and name-based merging silently merges different people.

## What I built

I designed the identity model and wrote the evaluation harness. Profiles are deduplicated by platform ID or canonical profile URL; name matches are only suggested for a manual confirm.

## Results

- 0 false merges on 4,112 real contacts (was 37 with name-based merging).
- 61 duplicates now need a manual confirm.

## Limitations

- Only Gmail and LinkedIn exports are supported.
- No phone-number matching yet.
`,
      "eval/results.csv": "method,contacts,false_merges,manual_confirms\nname_match,4112,37,0\nplatform_id,4112,0,61\n",
      "src/merge.rs": "// Identity resolution: merge only on stable platform IDs or canonical profile URLs.\npub fn same_identity(a: &Profile, b: &Profile) -> bool { a.platform_id == b.platform_id }\n",
    },
  },
  "Graph thesis": {
    ai: "allowed",
    files: {
      "README.md": `# Graph thesis

Community detection on sparse social graphs. Master's thesis.

## Contribution

The method and chapters 1 to 3 are mine.

## Results

- 11% better modularity than Louvain on 3 of 4 sparse social graph datasets.
- Modularity drops on graphs with many isolated, degree-0 nodes; pruning them before detection and reattaching after keeps modularity stable.
`,
      "thesis/ch3.tex": "\\chapter{Applying sparse-graph community detection to social data}\nWe apply the sparse-graph community detection method to three social graphs and compare modularity with Louvain.\n",
      "bench/run.py": "# Benchmark: modularity of sparse-graph community detection vs Louvain\nimport networkx as nx\n",
      "bench/notes.md": "# Bench notes\n\nIsolated nodes hurt modularity. Workaround: prune degree-0 nodes before community detection, reattach after.\n",
    },
  },
  HackMap: {
    ai: "denied",
    files: {
      "README.md": `# HackMap

Matches hackathon participants into balanced teams by skill, so nobody ends up on a team of four backend developers.

## What I built

The team matching algorithm and the web UI.

## Results

- Used by 140 people at one hackathon.

## Limitations

- Not tested beyond 500 participants.
`,
      "DEMO.md": "# Demo\n\nLive demo of hackathon team matching: upload participants, get balanced teams.\n",
      "app/match.ts": "// Balanced hackathon team matching by skill coverage.\nexport function matchTeams() {}\n",
    },
  },
};

async function person(name: string, title: string, organization: string, profiles: Array<{ platform: string; url: string }>, status: "prospect" | "contact" = "contact") {
  const p = await api("POST", "/people", { displayName: name, title, organization, status, profiles });
  return p.id as string;
}

async function talk(personId: string, platform: string, direction: "outbound" | "inbound", type: string, body: string, ago: number) {
  await api("POST", "/interactions", {
    platform,
    type,
    direction,
    occurredAt: daysAgo(ago),
    body,
    participants: [{ personId, role: direction === "outbound" ? "recipient" : "sender" }],
  });
}

async function main() {
  const status = await api("GET", "/status");
  if (status.counts.projects > 0) {
    console.log(`Already seeded (${status.counts.projects} projects in ${status.storage.dataDir}). Delete that folder to reset.`);
    return;
  }
  const demoRoot = path.join(status.storage.dataDir, "demo");
  await api("PATCH", "/me", { displayName: "You", title: "CS student" });

  const projects: Record<string, string> = {};
  for (const [name, f] of Object.entries(FOLDERS)) {
    const dir = path.join(demoRoot, name);
    write(dir, f.files);
    const res = await api("POST", "/projects", { folderPath: dir, name, aiPermission: f.ai });
    projects[name] = res.project.id;
    console.log(`project ${name}: ${res.processing?.summary?.method ?? "scanned"}`);
  }

  // People already in the network, with history (prototype's Priya, Alex, Mei, Omar, Lena).
  const priya = await person("Priya Menon", "ML engineer", "Lumen", [{ platform: "linkedin", url: "https://www.linkedin.com/in/demo-priya-menon" }, { platform: "github", url: "https://github.com/demo-priya" }]);
  const alex = await person("Alex Romero", "Founder", "Threadline", [{ platform: "linkedin", url: "https://www.linkedin.com/in/demo-alex-romero" }, { platform: "x", url: "https://x.com/demo_alex" }]);
  const mei = await person("Mei Tanaka", "Open-source maintainer", "graphkit", [{ platform: "github", url: "https://github.com/demo-mei" }]);
  const omar = await person("Omar Haddad", "Research engineer", "Lumen", [{ platform: "linkedin", url: "https://www.linkedin.com/in/demo-omar-haddad" }]);
  const lena = await person("Lena Fischer", "Product designer", "Fable Labs", [{ platform: "linkedin", url: "https://www.linkedin.com/in/demo-lena-fischer" }], "prospect");

  await talk(priya, "linkedin", "outbound", "comment", "We stopped merging by name: CubeSync keys on platform IDs. 0 false merges on 4k contacts.", 23);
  await talk(priya, "linkedin", "inbound", "message", "This is great. Could you share the eval notebook?", 22);
  await talk(alex, "x", "outbound", "message", "Had the same team-matching problem, so I built HackMap. Demo link inside.", 15);
  await talk(alex, "x", "inbound", "message", "Nice! Does it scale past 500 people?", 13);
  await talk(mei, "github", "outbound", "comment", "Repro for the sparse-graph modularity drop, plus a pruning workaround.", 37);
  await talk(mei, "github", "inbound", "comment", "Thanks, would you open a PR?", 36);
  await talk(omar, "linkedin", "inbound", "comment", "Interesting eval results, how did you pick the test set?", 22);
  await talk(lena, "linkedin", "outbound", "comment", "Here is a case study of fair team matching from HackMap.", 9);

  const rel = (fromPersonId: string, toPersonId: string, type: string, platform: string, evidence: string) =>
    api("POST", "/relationships", { fromPersonId, toPersonId, type, platform, evidence, observedAt: daysAgo(20) });
  const me = (await api("GET", "/me")).id;
  await rel(me, priya, "connection", "linkedin", "Connection accepted on LinkedIn");
  await rel(me, omar, "connection", "linkedin", "Connection accepted on LinkedIn");
  await rel(me, mei, "follows", "github", "She followed you on GitHub");
  await rel(priya, omar, "colleague", "linkedin", "Same team at Lumen, per both profiles");
  await rel(alex, lena, "connection", "linkedin", "Connected on LinkedIn, per import");

  await api("POST", "/followups", { personId: priya, reason: "Send the eval notebook she asked about", dueAt: inDays(2), projectId: projects.CubeSync });
  await api("POST", "/followups", { personId: alex, reason: "Share HackMap v2 demo when ready", dueAt: inDays(5), projectId: projects.HackMap });
  await api("POST", "/followups", { personId: mei, reason: "Thank her. Your PR was merged", dueAt: inDays(7), projectId: projects["Graph thesis"] });
  await api("POST", "/followups", { personId: lena, reason: "No reply yet. Check again", dueAt: inDays(4), projectId: projects.HackMap });

  // New conversations: each becomes a scored opportunity against the projects.
  const posts = [
    { platform: "linkedin", url: "https://www.linkedin.com/posts/demo-sam-okafor-1", days: 1, author: { url: "https://www.linkedin.com/in/demo-sam-okafor", displayName: "Sam Okafor", headline: "PhD student, ETH Zürich" },
      text: "Has anyone applied our sparse-graph community detection method outside citation networks? Curious how modularity behaves on social graph data compared to Louvain." },
    { platform: "linkedin", url: "https://www.linkedin.com/posts/demo-jordan-lee-1", days: 2, author: { url: "https://www.linkedin.com/in/demo-jordan-lee", displayName: "Jordan Lee", headline: "Engineering recruiter, Northwind" },
      text: "Hiring: engineer who has actually shipped entity resolution and contact deduplication. Identity resolution across platforms is the core of the role. Side projects count." },
    { platform: "x", url: "https://x.com/demo_kai/status/1", days: 0.2, author: { url: "https://x.com/demo_kai", displayName: "Kai Novak", headline: "Indie hacker" },
      text: "Every hackathon I end up on a team of four backend developers. Why is there no decent hackathon team matching tool that balances skills?" },
    { platform: "github", url: "https://github.com/demo/graphkit/issues/412", days: 3, author: { url: "https://github.com/demo-rina", displayName: "Rina Das", headline: "OSS contributor" },
      text: "Modularity drops sharply on sparse graphs with many isolated degree-0 nodes during community detection. Is this expected?" },
    { platform: "linkedin", url: "https://www.linkedin.com/posts/demo-theo-martin-1", days: 4, author: { url: "https://www.linkedin.com/in/demo-theo-martin", displayName: "Theo Martin", headline: "Data engineer" },
      text: "How do you deduplicate contacts from Gmail and LinkedIn exports without merging different people by name? Looking for recommendations." },
  ];
  let opps = 0;
  for (const p of posts) {
    const res = await api("POST", "/source-posts", { platform: p.platform, url: p.url, text: p.text, publishedAt: daysAgo(p.days), author: p.author, match: true });
    opps += res.opportunities.length;
  }

  // Extra first-degree connections, as from a LinkedIn archive export.
  // First name, last name, position, company: a spread of industries for the network's group filter.
  const extra = [
    "Ana,Silva,Robotics engineer,Kinetica Robotics",
    "Yuki,Sato,Embedded engineer,Kinetica Robotics",
    "Ben,Carter,Quant analyst,Harbor Capital",
    "Leo,Park,Fintech product manager,Ledgerline",
    "Ines,Duarte,Biomedical researcher,Northlake Health",
    "Zara,Ali,ML researcher,",
    "Maya,Cohen,Developer advocate,",
  ];
  const csv = `Notes:\n"Demo export"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\n${extra
    .map((e) => {
      const [f = "", l = "", pos = "", company = ""] = e.split(",");
      return `${f},${l},https://www.linkedin.com/in/demo-${f.toLowerCase()}-${l.toLowerCase()},,${company},${pos},01 Oct 2026`;
    })
    .join("\n")}\n`;
  await api("POST", "/imports/linkedin-archive", { files: { "Connections.csv": csv } });

  console.log(`Seeded ${Object.keys(projects).length} projects, ${posts.length} posts → ${opps} opportunities, ${5 + extra.length + posts.length} people.`);
}

main().catch((err) => {
  console.error(String(err));
  console.error("Is the backend running? Start it with `npm run demo`.");
  process.exit(1);
});
