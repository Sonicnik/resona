import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseNote, stringifyFrontmatter, extractWikilinks, splitGenerated } from "../src/vault/markdown.ts";
import { parseCsv } from "../src/lib/csv.ts";
import { makeServices } from "./helpers.ts";

test("frontmatter round-trips the vault subset", () => {
  const fm = { resona_id: "person:per_1", title: "CTO: Acme", count: 3, ok: true, none: null, tags: ["a", "b c"], empty: [] };
  const parsed = parseNote(`${stringifyFrontmatter(fm)}\nbody`);
  assert.deepEqual(parsed.frontmatter, fm);
  assert.equal(parsed.body, "body");
  assert.deepEqual(extractWikilinks("see [[People/Ana|Ana]] and [[Bob#notes]] and [[Ana]]"), ["People/Ana", "Bob", "Ana"]);
  assert.equal(splitGenerated("no markers").generated, null);
});

test("csv parser handles quotes, commas and newlines", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","multi\nline ""q"""\n'), [["a", "b"], ["x, y", 'multi\nline "q"']]);
});

test("vault: notes are written, user edits are imported and preserved, renames are followed", () => {
  const s = makeServices();
  const ana = s.people.create({ displayName: "Ana Lima", organization: "Acme" });
  const bo = s.people.create({ displayName: "Bo" });
  s.relationships.upsertRelationship({ fromPersonId: s.people.selfId(), toPersonId: ana.id, type: "connection", platform: "linkedin", verificationSource: "archive_import" });
  s.relationships.recordInteraction({
    platform: "linkedin", type: "message", direction: "inbound", occurredAt: "2026-10-01T10:00:00Z", body: "Hello!", threadId: "t1",
    participants: [{ personId: ana.id, role: "sender" }, { personId: s.people.selfId(), role: "recipient" }],
  });
  const first = s.vault.sync();
  assert.ok(first.written >= 4);
  const notePath = path.join(s.vault.vaultDir, "People", "Ana Lima.md");
  let note = fs.readFileSync(notePath, "utf8");
  assert.match(note, /resona_id: "person:/);
  assert.match(note, /\[\[People\/Me\|Me\]\]: connection on linkedin/);
  assert.match(note, /\[\[Conversations\//);
  assert.ok(fs.existsSync(path.join(s.vault.vaultDir, "Resona Home.md")));

  // Second sync without changes rewrites nothing.
  assert.equal(s.vault.sync().written, 0);

  // Edit in Obsidian: notes section, frontmatter, a wikilink, a custom key, and text inside the generated block.
  note = note
    .replace("## Notes\n", "## Notes\nMet at the meetup; knows [[Bo]].\n")
    .replace("organization: Acme", "organization: Acme Labs\nmy_key: keep me")
    .replace("## Profiles", "## Profiles\nTHIS WILL BE OVERWRITTEN");
  fs.writeFileSync(notePath, note);
  // Rename Bo's note.
  fs.renameSync(path.join(s.vault.vaultDir, "People", "Bo.md"), path.join(s.vault.vaultDir, "People", "Bo (uni).md"));

  const second = s.vault.sync();
  assert.equal(second.imported, 1);
  const updated = s.people.get(ana.id);
  assert.equal(updated.notes, "Met at the meetup; knows [[Bo]].");
  assert.equal(updated.organization, "Acme Labs");
  note = fs.readFileSync(notePath, "utf8");
  assert.match(note, /my_key: keep me/, "user frontmatter keys are kept");
  assert.match(note, /knows \[\[Bo\]\]/, "user section is preserved");
  assert.doesNotMatch(note, /THIS WILL BE OVERWRITTEN/, "generated block is regenerated");
  assert.ok(fs.existsSync(path.join(s.vault.vaultDir, "People", "Bo (uni).md")), "rename is respected");
  assert.ok(!fs.existsSync(path.join(s.vault.vaultDir, "People", "Bo.md")));
  const mentions = s.db.all<{ resolved_id: string }>("SELECT resolved_id FROM vault_links WHERE from_entity_id = ?", [ana.id]);
  assert.deepEqual(mentions.map((m) => m.resolved_id), [bo.id]);

  // Deleting a person removes an untouched note, but keeps an edited one.
  s.people.delete(bo.id);
  s.people.delete(ana.id);
  const third = s.vault.sync();
  assert.ok(!fs.existsSync(path.join(s.vault.vaultDir, "People", "Bo (uni).md")));
  assert.equal(third.kept, 0, "Ana's edits were already imported, so the note matches what was last written");
  s.close();
});

test("LinkedIn archive import: connections, threads, self inference, idempotent", () => {
  const s = makeServices();
  const files = {
    "Connections.csv": `Notes:\n"Some emails may be missing"\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nPriya,Raman,https://www.linkedin.com/in/priya,,Acme,Data Scientist,12 Mar 2025\nTom,Lee,https://www.linkedin.com/in/tom,tom@x.com,Lab,Researcher,05 Jan 2024\n`,
    "messages.csv": `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER
c1,,Priya Raman,https://www.linkedin.com/in/priya,Me,https://www.linkedin.com/in/me,2025-04-01 10:00:00 UTC,,"Hi, how do you evaluate RAG?",INBOX
c1,,Me,https://www.linkedin.com/in/me,Priya Raman,https://www.linkedin.com/in/priya,2025-04-02 10:00:00 UTC,,"By hand, for now.",INBOX
c2,,Tom Lee,https://www.linkedin.com/in/tom,Me,https://www.linkedin.com/in/me,2024-02-01 09:00:00 UTC,,"Great meeting you",INBOX
c3,Study group,Zed,https://www.linkedin.com/in/zed,"Me, Tom Lee","https://www.linkedin.com/in/me,https://www.linkedin.com/in/tom",2024-03-01 09:00:00 UTC,,"Group hello",INBOX
`,
  };
  const report = s.imports.linkedInArchive({ files });
  assert.equal(report.selfProfileUrl, "https://linkedin.com/in/me");
  assert.equal(report.connections.relationships, 2);
  assert.equal(report.messages.interactionsCreated, 4);
  const again = s.imports.linkedInArchive({ files });
  assert.equal(again.messages.interactionsCreated, 0);
  assert.equal(again.messages.duplicates, 4);
  assert.equal(again.connections.peopleCreated, 0);

  const priya = s.people.list({ q: "Priya" })[0]!;
  const ints = s.relationships.interactionsFor(priya.id) as Array<{ direction: string; thread_id: string }>;
  assert.deepEqual(ints.map((i) => i.direction).sort(), ["inbound", "outbound"]);
  assert.ok(ints.every((i) => i.thread_id === "linkedin:c1"));
  const g = s.network.graph();
  const zed = s.people.list({ q: "Zed" })[0]!;
  assert.ok(!g.edges.some((e) => e.kind === "interaction" && (e.from === zed.id || e.to === zed.id)), "group message creates no edge");
  s.close();
});
