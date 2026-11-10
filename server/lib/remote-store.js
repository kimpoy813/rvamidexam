/**
 * Durable remote storage adapters for the Render exam server.
 *
 * Supports two connection modes against the same PostgreSQL schema
 * (see `supabase/schema.sql`):
 *  1. Supabase HTTPS REST API (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` or
 *     `SUPABASE_SECRET_KEY`) — works over IPv4/HTTPS on Render Free tier with
 *     zero connection-pool or IPv6 pitfalls.
 *  2. Direct / pooled PostgreSQL (`SUPABASE_DB_URL` or `DATABASE_URL`) via `pg`.
 */
import fs from 'node:fs';
import pg from 'pg';

const SCHEMA_SQL = fs.readFileSync(
  new URL('../../supabase/schema.sql', import.meta.url),
  'utf8'
);

function inspectJwtRole(key) {
  if (!key.startsWith('eyJ')) return null;
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.role || null;
  } catch {
    return null;
  }
}

export function resolveRemoteConfig(env = process.env) {
  const supabaseUrl = String(env.SUPABASE_URL || '').trim();
  const supabaseKey = String(
    env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || ''
  ).trim();
  const databaseUrl = String(env.SUPABASE_DB_URL || env.DATABASE_URL || '').trim();

  if ((supabaseUrl && !supabaseKey) || (!supabaseUrl && supabaseKey)) {
    throw new Error(
      'Supabase REST storage requires both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY).'
    );
  }

  if (supabaseUrl && supabaseKey) {
    if (!/^https?:\/\//i.test(supabaseUrl)) {
      throw new Error('SUPABASE_URL must start with https:// (for example, https://<project-ref>.supabase.co).');
    }
    if (supabaseKey.startsWith('sb_publishable_')) {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY is set to a publishable key. Use the service_role or secret key from Supabase Project Settings -> API.'
      );
    }
    if (inspectJwtRole(supabaseKey) === 'anon') {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY is set to the public anon key. Use the service_role secret key from Supabase Project Settings -> API.'
      );
    }
    return {
      driver: 'supabase-rest',
      mode: 'supabase',
      url: supabaseUrl,
      key: supabaseKey
    };
  }

  if (databaseUrl) {
    const isSupabase = /supabase\.(co|com)/i.test(databaseUrl);
    return {
      driver: 'postgres',
      mode: isSupabase ? 'supabase' : 'postgres',
      connectionString: databaseUrl
    };
  }

  return null;
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function uniqueStrings(items) {
  return [...new Set((items || []).filter((x) => x !== undefined && x !== null && x !== '').map(String))];
}

function normalizeDataset(raw) {
  return {
    teachers: (raw.teachers || []).map((r) => ({
      id: Number(r.id),
      username: String(r.username),
      pass_hash: String(r.pass_hash),
      salt: String(r.salt),
      created_at: Number(r.created_at)
    })),
    teacher_tokens: (raw.teacher_tokens || []).map((r) => ({
      token: String(r.token),
      teacher_id: Number(r.teacher_id),
      created_at: Number(r.created_at)
    })),
    exams: (raw.exams || []).map((r) => ({
      id: String(r.id),
      title: String(r.title),
      access_code: String(r.access_code),
      settings: String(r.settings ?? '{}'),
      created_at: Number(r.created_at),
      teacher_id: r.teacher_id == null ? null : Number(r.teacher_id)
    })),
    settings: (raw.settings || []).map((r) => ({
      key: String(r.key),
      value: String(r.value)
    })),
    sections: (raw.sections || []).map((r) => ({
      id: String(r.id),
      exam_id: r.exam_id == null ? null : String(r.exam_id),
      ord: Number(r.ord ?? 0),
      title: String(r.title),
      instructions: String(r.instructions ?? ''),
      lock_after: Number(r.lock_after ?? 1),
      minutes: Number(r.minutes ?? 0)
    })),
    questions: (raw.questions || []).map((r) => ({
      id: String(r.id),
      section_id: String(r.section_id),
      ord: Number(r.ord ?? 0),
      kind: String(r.kind),
      prompt: String(r.prompt),
      choices: String(r.choices ?? '[]'),
      answer: r.answer == null ? null : String(r.answer),
      points: Number(r.points ?? 1),
      shuffle: Number(r.shuffle ?? 1),
      tags: String(r.tags ?? '')
    })),
    sessions: (raw.sessions || []).map((r) => ({
      token: String(r.token),
      exam_id: r.exam_id == null ? null : String(r.exam_id),
      access_code: String(r.access_code),
      student_name: String(r.student_name),
      student_no: String(r.student_no),
      class_section: String(r.class_section ?? ''),
      status: String(r.status ?? 'active'),
      created_at: Number(r.created_at),
      started_at: r.started_at == null ? null : Number(r.started_at),
      deadline: r.deadline == null ? null : Number(r.deadline),
      last_seen: Number(r.last_seen),
      order_seed: Number(r.order_seed),
      answers: String(r.answers ?? '{}'),
      section_index: Number(r.section_index ?? 0),
      max_section: Number(r.max_section ?? 0),
      cursor: Number(r.cursor ?? 0),
      reloads: Number(r.reloads ?? 0),
      ip: String(r.ip ?? ''),
      user_agent: String(r.user_agent ?? ''),
      submitted_at: r.submitted_at == null ? null : Number(r.submitted_at),
      score: r.score == null ? null : Number(r.score),
      max_score: r.max_score == null ? null : Number(r.max_score),
      pending_manual: Number(r.pending_manual ?? 0),
      violations: Number(r.violations ?? 0),
      flagged: Number(r.flagged ?? 0),
      manual_notes: String(r.manual_notes ?? ''),
      manual_scores: String(r.manual_scores ?? '{}')
    })),
    events: (raw.events || []).map((r) => ({
      id: Number(r.id),
      token: String(r.token),
      at: Number(r.at),
      type: String(r.type),
      detail: String(r.detail ?? '')
    }))
  };
}

/* --------------------------------------------------- Supabase REST adapter */

function encodePostgrestInValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function createSupabaseRestStore({ url, key, fetchImpl = globalThis.fetch }) {
  const baseUrl = url.replace(/\/+$/, '') + '/rest/v1';
  const authHeaders = { apikey: key };
  // Legacy service_role keys are JWTs and use Bearer auth; new sb_secret_* keys
  // authenticate via `apikey` and let the Supabase gateway mint the role token.
  if (key.startsWith('eyJ')) {
    authHeaders.Authorization = `Bearer ${key}`;
  }

  async function request(pathAndQuery, { method = 'GET', headers = {}, body } = {}) {
    const res = await fetchImpl(`${baseUrl}${pathAndQuery}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...authHeaders,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000)
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      let code = '';
      try {
        const errJson = await res.json();
        code = String(errJson?.code || '');
        detail = errJson?.message || errJson?.error || detail;
      } catch {
        try {
          const txt = await res.text();
          if (txt) detail = txt.slice(0, 200);
        } catch { /* ignore */ }
      }
      if (code === '42P01' || code === 'PGRST205') {
        throw new Error(
          `Supabase table missing (${detail}). Run supabase/schema.sql in your Supabase SQL Editor.`
        );
      }
      if (res.status === 401 || res.status === 403 || code === '42501') {
        throw new Error(
          `Supabase rejected credentials (${detail}). Ensure SUPABASE_SERVICE_ROLE_KEY is your service_role / secret key.`
        );
      }
      throw new Error(`Supabase REST ${method} failed: ${detail}`);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function selectAll(table, orderSpec) {
    const pageSize = 1000;
    const all = [];
    let offset = 0;
    while (true) {
      const qs = new URLSearchParams({
        select: '*',
        order: orderSpec,
        limit: String(pageSize),
        offset: String(offset)
      });
      const page = await request(`/${table}?${qs.toString()}`);
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
    return all;
  }

  async function upsertRows(table, rows, conflictCol) {
    if (!rows || !rows.length) return;
    const qs = new URLSearchParams({ on_conflict: conflictCol });
    for (const chunk of chunkArray(rows, 200)) {
      await request(`/${table}?${qs.toString()}`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: chunk
      });
    }
  }

  async function deleteIn(table, column, values) {
    const unique = uniqueStrings(values);
    if (!unique.length) return;
    for (const chunk of chunkArray(unique, 100)) {
      const filter = `in.(${chunk.map(encodePostgrestInValue).join(',')})`;
      const qs = new URLSearchParams({ [column]: filter });
      await request(`/${table}?${qs.toString()}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' }
      });
    }
  }

  async function deleteAll(table, nonNullColumn) {
    const qs = new URLSearchParams({ [nonNullColumn]: 'not.is.null' });
    await request(`/${table}?${qs.toString()}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
  }

  async function loadAll() {
    const [
      teachers,
      teacher_tokens,
      exams,
      settings,
      sections,
      questions,
      sessions,
      events
    ] = await Promise.all([
      selectAll('teachers', 'id.asc'),
      selectAll('teacher_tokens', 'created_at.asc'),
      selectAll('exams', 'created_at.asc,id.asc'),
      selectAll('settings', 'key.asc'),
      selectAll('sections', 'ord.asc,id.asc'),
      selectAll('questions', 'ord.asc,id.asc'),
      selectAll('sessions', 'created_at.asc,token.asc'),
      selectAll('events', 'id.asc')
    ]);
    return normalizeDataset({
      teachers,
      teacher_tokens,
      exams,
      settings,
      sections,
      questions,
      sessions,
      events
    });
  }

  async function pushBatch(batch) {
    await upsertRows('teachers', batch.upsertTeachers, 'id');

    await deleteIn('teacher_tokens', 'token', batch.deleteTokens);
    await upsertRows('teacher_tokens', batch.upsertTokens, 'token');

    await upsertRows('exams', batch.upsertExams, 'id');

    await deleteIn('settings', 'key', batch.deleteSettings);
    await upsertRows('settings', batch.upsertSettings, 'key');

    const sectionClearExamIds = uniqueStrings([
      ...(batch.replaceBankExamIds || []),
      ...(batch.deleteExams || [])
    ]);
    if (sectionClearExamIds.length) {
      await deleteIn('sections', 'exam_id', sectionClearExamIds);
    }
    await upsertRows('sections', batch.upsertSections, 'id');
    await upsertRows('questions', batch.upsertQuestions, 'id');

    if (batch.clearAllSessions) {
      await deleteAll('events', 'id');
      await deleteAll('sessions', 'token');
    } else {
      await deleteIn('events', 'token', batch.deleteEventTokens);
      const sessionClearExamIds = uniqueStrings([
        ...(batch.clearSessionExamIds || []),
        ...(batch.deleteExams || [])
      ]);
      if (sessionClearExamIds.length) {
        await deleteIn('sessions', 'exam_id', sessionClearExamIds);
      }
    }

    await deleteIn('exams', 'id', batch.deleteExams);

    await upsertRows('sessions', batch.upsertSessions, 'token');
    await upsertRows('events', batch.upsertEvents, 'id');
  }

  return {
    mode: 'supabase',
    async init() {
      return loadAll();
    },
    loadAll,
    pushBatch,
    async close() {}
  };
}

/* ----------------------------------------------------- PostgreSQL adapter */

function buildPgPoolConfig(connectionString) {
  const cfg = {
    connectionString,
    max: 5,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000
  };
  try {
    const parsed = new URL(connectionString);
    const sslmode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
    const isSupabaseHost = /supabase\.(co|com)$/i.test(parsed.hostname);
    if (isSupabaseHost && sslmode !== 'disable' && sslmode !== 'verify-full' && !process.env.PGSSLROOTCERT) {
      cfg.ssl = { rejectUnauthorized: false };
    }
  } catch { /* let pg parse non-URL connection strings */ }
  return cfg;
}

export function createPostgresStore({ connectionString, mode = 'postgres', pool: externalPool } = {}) {
  if (!connectionString && !externalPool) {
    throw new Error('DATABASE_URL or SUPABASE_DB_URL is required for PostgreSQL storage.');
  }
  const pool = externalPool || new pg.Pool(buildPgPoolConfig(connectionString));
  if (!externalPool) {
    pool.on('error', (err) => {
      console.error('[exam] idle PostgreSQL client error:', err.code || err.message);
    });
  }

  async function loadAllWith(queryable) {
    const [
      teachers,
      teacher_tokens,
      exams,
      settings,
      sections,
      questions,
      sessions,
      events
    ] = await Promise.all([
      queryable.query('SELECT * FROM teachers ORDER BY id ASC'),
      queryable.query('SELECT * FROM teacher_tokens ORDER BY created_at ASC'),
      queryable.query('SELECT * FROM exams ORDER BY created_at ASC, id ASC'),
      queryable.query('SELECT * FROM settings ORDER BY key ASC'),
      queryable.query('SELECT * FROM sections ORDER BY ord ASC, id ASC'),
      queryable.query('SELECT * FROM questions ORDER BY ord ASC, id ASC'),
      queryable.query('SELECT * FROM sessions ORDER BY created_at ASC, token ASC'),
      queryable.query('SELECT * FROM events ORDER BY id ASC')
    ]);
    return normalizeDataset({
      teachers: teachers.rows,
      teacher_tokens: teacher_tokens.rows,
      exams: exams.rows,
      settings: settings.rows,
      sections: sections.rows,
      questions: questions.rows,
      sessions: sessions.rows,
      events: events.rows
    });
  }

  async function init() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [72361949]);
      await client.query(SCHEMA_SQL);
      await client.query('COMMIT');
      return await loadAllWith(client);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async function pushBatch(batch) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const t of batch.upsertTeachers || []) {
        await client.query(
          `INSERT INTO teachers(id, username, pass_hash, salt, created_at)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             username = EXCLUDED.username,
             pass_hash = EXCLUDED.pass_hash,
             salt = EXCLUDED.salt,
             created_at = EXCLUDED.created_at`,
          [t.id, t.username, t.pass_hash, t.salt, t.created_at]
        );
      }
      if ((batch.upsertTeachers || []).length) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('teachers', 'id'),
             GREATEST((SELECT COALESCE(MAX(id), 1) FROM teachers), 1), true)`
        );
      }

      const delTokens = uniqueStrings(batch.deleteTokens);
      if (delTokens.length) {
        await client.query('DELETE FROM teacher_tokens WHERE token = ANY($1::text[])', [delTokens]);
      }
      for (const tk of batch.upsertTokens || []) {
        await client.query(
          `INSERT INTO teacher_tokens(token, teacher_id, created_at)
           VALUES($1, $2, $3)
           ON CONFLICT (token) DO UPDATE SET
             teacher_id = EXCLUDED.teacher_id,
             created_at = EXCLUDED.created_at`,
          [tk.token, tk.teacher_id, tk.created_at]
        );
      }

      for (const ex of batch.upsertExams || []) {
        await client.query(
          `INSERT INTO exams(id, title, access_code, settings, created_at, teacher_id)
           VALUES($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title,
             access_code = EXCLUDED.access_code,
             settings = EXCLUDED.settings,
             created_at = EXCLUDED.created_at,
             teacher_id = EXCLUDED.teacher_id`,
          [ex.id, ex.title, ex.access_code, ex.settings, ex.created_at, ex.teacher_id]
        );
      }

      const delSettings = uniqueStrings(batch.deleteSettings);
      if (delSettings.length) {
        await client.query('DELETE FROM settings WHERE key = ANY($1::text[])', [delSettings]);
      }
      for (const st of batch.upsertSettings || []) {
        await client.query(
          `INSERT INTO settings(key, value) VALUES($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [st.key, st.value]
        );
      }

      const sectionClearExamIds = uniqueStrings([
        ...(batch.replaceBankExamIds || []),
        ...(batch.deleteExams || [])
      ]);
      if (sectionClearExamIds.length) {
        await client.query('DELETE FROM sections WHERE exam_id = ANY($1::text[])', [sectionClearExamIds]);
      }
      for (const sec of batch.upsertSections || []) {
        await client.query(
          `INSERT INTO sections(id, exam_id, ord, title, instructions, lock_after, minutes)
           VALUES($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             exam_id = EXCLUDED.exam_id,
             ord = EXCLUDED.ord,
             title = EXCLUDED.title,
             instructions = EXCLUDED.instructions,
             lock_after = EXCLUDED.lock_after,
             minutes = EXCLUDED.minutes`,
          [sec.id, sec.exam_id, sec.ord, sec.title, sec.instructions, sec.lock_after, sec.minutes]
        );
      }
      for (const q of batch.upsertQuestions || []) {
        await client.query(
          `INSERT INTO questions(id, section_id, ord, kind, prompt, choices, answer, points, shuffle, tags)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO UPDATE SET
             section_id = EXCLUDED.section_id,
             ord = EXCLUDED.ord,
             kind = EXCLUDED.kind,
             prompt = EXCLUDED.prompt,
             choices = EXCLUDED.choices,
             answer = EXCLUDED.answer,
             points = EXCLUDED.points,
             shuffle = EXCLUDED.shuffle,
             tags = EXCLUDED.tags`,
          [q.id, q.section_id, q.ord, q.kind, q.prompt, q.choices, q.answer, q.points, q.shuffle, q.tags]
        );
      }

      if (batch.clearAllSessions) {
        await client.query('DELETE FROM events');
        await client.query('DELETE FROM sessions');
      } else {
        const delEvTokens = uniqueStrings(batch.deleteEventTokens);
        if (delEvTokens.length) {
          await client.query('DELETE FROM events WHERE token = ANY($1::text[])', [delEvTokens]);
        }
        const sessionClearExamIds = uniqueStrings([
          ...(batch.clearSessionExamIds || []),
          ...(batch.deleteExams || [])
        ]);
        if (sessionClearExamIds.length) {
          await client.query('DELETE FROM sessions WHERE exam_id = ANY($1::text[])', [sessionClearExamIds]);
        }
      }

      const delExams = uniqueStrings(batch.deleteExams);
      if (delExams.length) {
        await client.query('DELETE FROM exams WHERE id = ANY($1::text[])', [delExams]);
      }

      for (const s of batch.upsertSessions || []) {
        await client.query(
          `INSERT INTO sessions(
             token, exam_id, access_code, student_name, student_no, class_section,
             status, created_at, started_at, deadline, last_seen, order_seed, answers,
             section_index, max_section, cursor, reloads, ip, user_agent, submitted_at,
             score, max_score, pending_manual, violations, flagged, manual_notes, manual_scores
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
           )
           ON CONFLICT (token) DO UPDATE SET
             exam_id = EXCLUDED.exam_id,
             access_code = EXCLUDED.access_code,
             student_name = EXCLUDED.student_name,
             student_no = EXCLUDED.student_no,
             class_section = EXCLUDED.class_section,
             status = EXCLUDED.status,
             created_at = EXCLUDED.created_at,
             started_at = EXCLUDED.started_at,
             deadline = EXCLUDED.deadline,
             last_seen = EXCLUDED.last_seen,
             order_seed = EXCLUDED.order_seed,
             answers = EXCLUDED.answers,
             section_index = EXCLUDED.section_index,
             max_section = EXCLUDED.max_section,
             cursor = EXCLUDED.cursor,
             reloads = EXCLUDED.reloads,
             ip = EXCLUDED.ip,
             user_agent = EXCLUDED.user_agent,
             submitted_at = EXCLUDED.submitted_at,
             score = EXCLUDED.score,
             max_score = EXCLUDED.max_score,
             pending_manual = EXCLUDED.pending_manual,
             violations = EXCLUDED.violations,
             flagged = EXCLUDED.flagged,
             manual_notes = EXCLUDED.manual_notes,
             manual_scores = EXCLUDED.manual_scores`,
          [
            s.token, s.exam_id, s.access_code, s.student_name, s.student_no, s.class_section,
            s.status, s.created_at, s.started_at, s.deadline, s.last_seen, s.order_seed, s.answers,
            s.section_index, s.max_section, s.cursor, s.reloads, s.ip, s.user_agent, s.submitted_at,
            s.score, s.max_score, s.pending_manual, s.violations, s.flagged, s.manual_notes, s.manual_scores
          ]
        );
      }

      for (const ev of batch.upsertEvents || []) {
        await client.query(
          `INSERT INTO events(id, token, at, type, detail)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             token = EXCLUDED.token,
             at = EXCLUDED.at,
             type = EXCLUDED.type,
             detail = EXCLUDED.detail`,
          [ev.id, ev.token, ev.at, ev.type, ev.detail]
        );
      }
      if ((batch.upsertEvents || []).length) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('events', 'id'),
             GREATEST((SELECT COALESCE(MAX(id), 1) FROM events), 1), true)`
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    mode,
    init,
    loadAll: () => loadAllWith(pool),
    pushBatch,
    async close() {
      if (!externalPool) await pool.end();
    }
  };
}

export function createConfiguredRemoteStore(env = process.env) {
  const cfg = resolveRemoteConfig(env);
  if (!cfg) return null;
  if (cfg.driver === 'supabase-rest') {
    return createSupabaseRestStore({ url: cfg.url, key: cfg.key });
  }
  return createPostgresStore({ connectionString: cfg.connectionString, mode: cfg.mode });
}
