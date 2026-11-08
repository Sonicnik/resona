/**
 * Ordered schema migrations. Each entry runs once inside a transaction and is recorded in
 * `schema_migrations`. Never edit an applied migration; append a new one.
 *
 * Design notes (see docs/product-reference.md §9):
 * - SQLite holds structured records, FTS5 provides exact-term search, and `embeddings` stores
 *   vectors for semantic matching. Vectors are never the source of truth for identity, dates,
 *   send status or relationships.
 * - Approved draft, sent message, received reply and accepted connection are separate records
 *   (`draft_actions`, `interactions`, `relationships`) and are never collapsed into one state.
 * - Outreach drafts and standalone post drafts share the generalized `drafts` /
 *   `draft_revisions` / `draft_actions` tables, distinguished by `drafts.kind`.
 * - External credentials are NOT stored here; connectors read them from the environment.
 */
export const MIGRATIONS: string[] = [
  /* 1: core schema */ `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE people (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    bio TEXT,
    organization TEXT,
    title TEXT,
    location TEXT,
    notes TEXT,
    interests TEXT NOT NULL DEFAULT '[]',
    is_self INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'prospect' CHECK (status IN ('self','prospect','contact','archived')),
    merged_into TEXT REFERENCES people(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX people_single_self ON people(is_self) WHERE is_self = 1;

  CREATE TABLE person_profiles (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    external_id TEXT,
    handle TEXT,
    url TEXT,
    display_name TEXT,
    headline TEXT,
    email TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (platform, external_id),
    UNIQUE (platform, url)
  );
  CREATE INDEX person_profiles_person ON person_profiles(person_id);

  CREATE TABLE relationships (
    id TEXT PRIMARY KEY,
    from_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    to_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('connection','follows','colleague','classmate','mentor','introduced','other')),
    direction TEXT NOT NULL CHECK (direction IN ('directed','mutual')),
    platform TEXT,
    observed_at TEXT,
    verification_source TEXT NOT NULL CHECK (verification_source IN ('platform_api','archive_import','user_confirmed','observed')),
    evidence TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (from_person_id, to_person_id, type, platform)
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project','cv')),
    folder_path TEXT NOT NULL UNIQUE,
    folder_bookmark TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
    ai_permission TEXT NOT NULL DEFAULT 'denied' CHECK (ai_permission IN ('denied','allowed')),
    exclusions TEXT NOT NULL DEFAULT '[]',
    last_scan_at TEXT,
    last_change_at TEXT,
    last_summarized_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rel_path TEXT NOT NULL,
    hash TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    file_kind TEXT,
    extracted_text TEXT,
    processing_state TEXT NOT NULL CHECK (processing_state IN ('pending','indexed','skipped','error','deleted')),
    skip_reason TEXT,
    error TEXT,
    first_seen_at TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    UNIQUE (project_id, rel_path)
  );

  CREATE TABLE content_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK (source_type IN ('project_file','source_post','interaction','project_context')),
    source_id TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX content_chunks_source ON content_chunks(source_type, source_id);

  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text, content='content_chunks', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER content_chunks_ai AFTER INSERT ON content_chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER content_chunks_ad AFTER DELETE ON content_chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER content_chunks_au AFTER UPDATE ON content_chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES content_chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector BLOB NOT NULL
  );

  CREATE TABLE project_contexts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('ai','extractive')),
    model TEXT,
    summary TEXT NOT NULL,
    problem TEXT,
    audience TEXT,
    built TEXT,
    contribution TEXT,
    results TEXT NOT NULL DEFAULT '[]',
    capabilities TEXT NOT NULL DEFAULT '[]',
    limitations TEXT NOT NULL DEFAULT '[]',
    keywords TEXT NOT NULL DEFAULT '[]',
    search_phrases TEXT NOT NULL DEFAULT '[]',
    evidence TEXT NOT NULL DEFAULT '[]',
    uncertainties TEXT NOT NULL DEFAULT '[]',
    shareable_material TEXT NOT NULL DEFAULT '[]',
    source_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, version)
  );

  CREATE TABLE clarification_questions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    context_version INTEGER,
    field TEXT NOT NULL,
    question TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
    answer TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT
  );

  CREATE TABLE source_posts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    author_profile_id TEXT REFERENCES person_profiles(id) ON DELETE SET NULL,
    author_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    url TEXT,
    title TEXT,
    text TEXT NOT NULL,
    published_at TEXT,
    retrieved_at TEXT NOT NULL,
    connector TEXT NOT NULL,
    query TEXT,
    engagement TEXT NOT NULL DEFAULT '{}',
    UNIQUE (platform, external_id)
  );

  CREATE TABLE opportunities (
    id TEXT PRIMARY KEY,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    source_post_id TEXT NOT NULL REFERENCES source_posts(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    project_context_id TEXT REFERENCES project_contexts(id) ON DELETE SET NULL,
    scenario TEXT NOT NULL,
    match_reason TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    relevance REAL NOT NULL,
    score_breakdown TEXT NOT NULL DEFAULT '{}',
    suggested_channel TEXT NOT NULL,
    suggested_action TEXT NOT NULL,
    flags TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','shortlisted','dismissed','acted_on')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source_post_id, project_id)
  );

  CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('outreach','post')),
    opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    project_context_id TEXT REFERENCES project_contexts(id) ON DELETE SET NULL,
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    platform TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('public_reply','direct_message','email','post','comment')),
    current_revision INTEGER NOT NULL DEFAULT 1,
    stale INTEGER NOT NULL DEFAULT 0,
    stale_reason TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE draft_revisions (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    title TEXT,
    body TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('ai','template','user')),
    model TEXT,
    source_refs TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE (draft_id, revision)
  );

  CREATE TABLE draft_actions (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    destination TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('awaiting_approval','approved','queued','sent','failed','uncertain','cancelled')),
    approved_at TEXT,
    queued_at TEXT,
    sent_at TEXT,
    external_message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE interactions (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('message','reply','comment','meeting','email','post_engagement','note')),
    direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound','mutual','none')),
    occurred_at TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    external_id TEXT,
    thread_id TEXT,
    source_ref TEXT,
    action_id TEXT REFERENCES draft_actions(id) ON DELETE SET NULL,
    is_group INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (platform, external_id)
  );
  CREATE INDEX interactions_occurred ON interactions(occurred_at);

  CREATE TABLE interaction_participants (
    interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('sender','recipient','attendee','mentioned','member')),
    PRIMARY KEY (interaction_id, person_id, role)
  );
  CREATE INDEX interaction_participants_person ON interaction_participants(person_id);

  CREATE TABLE followups (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    interaction_id TEXT REFERENCES interactions(id) ON DELETE SET NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    due_at TEXT,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','snoozed','dismissed')),
    origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user','suggested')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE ingestion_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    files_seen INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    files_deleted INTEGER NOT NULL DEFAULT 0,
    files_skipped INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error')),
    error TEXT
  );

  -- Processing history: every request that sends user material to a model provider.
  CREATE TABLE ai_requests (
    id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_refs TEXT NOT NULL DEFAULT '[]',
    input_chars INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    output_tokens INTEGER,
    status TEXT NOT NULL CHECK (status IN ('ok','error','refused','blocked')),
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE job_runs (
    name TEXT PRIMARY KEY,
    last_started_at TEXT,
    last_finished_at TEXT,
    last_status TEXT,
    last_error TEXT
  );

  CREATE TABLE weekly_reviews (
    id TEXT PRIMARY KEY,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE vault_files (
    path TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    generated_hash TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    last_written_at TEXT NOT NULL,
    UNIQUE (entity_type, entity_id)
  );

  -- Wikilinks the user typed in vault notes. These are mentions, never relationship claims.
  CREATE TABLE vault_links (
    from_entity_type TEXT NOT NULL,
    from_entity_id TEXT NOT NULL,
    target TEXT NOT NULL,
    resolved_type TEXT,
    resolved_id TEXT,
    PRIMARY KEY (from_entity_type, from_entity_id, target)
  );
  `,
  // An AI-written one-sentence summary of the post, set by the optional fit check.
  `ALTER TABLE opportunities ADD COLUMN situation TEXT;`,
  // Industry chosen by the user for a person (network groups). NULL means "infer it".
  `ALTER TABLE people ADD COLUMN industry TEXT;`,
];
