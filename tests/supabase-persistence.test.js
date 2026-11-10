import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRemoteConfig } from '../server/lib/remote-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  socket.close();
  await once(socket, 'close');
  return port;
}

function parseInFilter(expr) {
  const inner = expr.slice(4, -1); // strip `in.(` and `)`
  const out = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === ',') { i++; continue; }
    if (inner[i] === '"') {
      let val = '';
      i++;
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === '\\' && i + 1 < inner.length) {
          i++;
          val += inner[i];
        } else {
          val += inner[i];
        }
        i++;
      }
      i++; // closing quote
      out.push(val);
    } else {
      let end = inner.indexOf(',', i);
      if (end === -1) end = inner.length;
      out.push(inner.slice(i, end));
      i = end;
    }
  }
  return out;
}

/** Minimal in-memory PostgREST server emulating Supabase `/rest/v1/<table>`. */
async function startMockSupabaseServer(expectedKey) {
  const tables = {
    teachers: new Map(),
    teacher_tokens: new Map(),
    exams: new Map(),
    settings: new Map(),
    sections: new Map(),
    questions: new Map(),
    sessions: new Map(),
    events: new Map()
  };
  const pkOf = {
    teachers: 'id',
    teacher_tokens: 'token',
    exams: 'id',
    settings: 'key',
    sections: 'id',
    questions: 'id',
    sessions: 'token',
    events: 'id'
  };

  let failWrites = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.apikey !== expectedKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Invalid API key' }));
      return;
    }
    const match = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!match || !(match[1] in tables)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'PGRST205', message: 'Relation not found' }));
      return;
    }
    const tableName = match[1];
    const store = tables[tableName];
    const pk = pkOf[tableName];

    if (req.method === 'GET') {
      let rows = [...store.values()];
      const order = url.searchParams.get('order') || '';
      if (order) {
        const specs = order.split(',').map((part) => {
          const [col, dir] = part.split('.');
          return { col, desc: dir === 'desc' };
        });
        rows.sort((a, b) => {
          for (const { col, desc } of specs) {
            if (a[col] === b[col]) continue;
            const cmp = a[col] < b[col] ? -1 : 1;
            return desc ? -cmp : cmp;
          }
          return 0;
        });
      }
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 1000);
      const page = rows.slice(offset, offset + limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(page));
      return;
    }

    if (failWrites) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Simulated Supabase write outage' }));
      return;
    }

    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const list = Array.isArray(body) ? body : [body];
      for (const item of list) {
        store.set(String(item[pk]), { ...item });
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('');
      return;
    }

    if (req.method === 'DELETE') {
      for (const [col, filter] of url.searchParams.entries()) {
        if (filter === 'not.is.null') {
          for (const [k, row] of store.entries()) {
            if (row[col] !== null && row[col] !== undefined) {
              if (tableName === 'sections') {
                for (const [qk, q] of tables.questions.entries()) {
                  if (q.section_id === row.id) tables.questions.delete(qk);
                }
              }
              store.delete(k);
            }
          }
        } else if (filter.startsWith('in.(') && filter.endsWith(')')) {
          const targets = new Set(parseInFilter(filter));
          for (const [k, row] of store.entries()) {
            if (targets.has(String(row[col]))) {
              if (tableName === 'sections') {
                for (const [qk, q] of tables.questions.entries()) {
                  if (q.section_id === row.id) tables.questions.delete(qk);
                }
              }
              store.delete(k);
            }
          }
        }
      }
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    tables,
    setFailWrites(v) { failWrites = v; },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  };
}

function launchOnRender({ dataDir, port, supabaseUrl, supabaseKey }) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      RENDER: 'true',
      EXAM_DATA_DIR: dataDir,
      EXAM_DB: path.join(dataDir, 'ephemeral.sqlite'),
      EXAM_STORAGE_MODE: '',
      EXAM_ALLOW_EPHEMERAL: '',
      EXAM_TEACHER_PASSWORD: 'initial-supabase-pass',
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: supabaseKey
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    const inspect = () => {
      if (/is running/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited before startup (${code ?? signal}):\n${output}`));
    });
  });

  return { child, ready, output: () => output };
}

async function stop(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(signal, null, `server was killed by ${signal}:\n${server.output()}`);
  assert.equal(code, 0, `server shutdown failed:\n${server.output()}`);
}

async function api(base, url, { method = 'GET', body, token, rawText = false } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = rawText ? 'text/plain; charset=utf-8' : 'application/json';
  }
  if (token) headers['X-Teacher-Token'] = token;
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : (rawText ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

test('resolveRemoteConfig validates Supabase credentials and rejects public anon keys', () => {
  assert.equal(resolveRemoteConfig({}), null);

  assert.throws(
    () => resolveRemoteConfig({ SUPABASE_URL: 'https://example.supabase.co' }),
    /both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/i
  );

  assert.throws(
    () => resolveRemoteConfig({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_abc123'
    }),
    /publishable key/i
  );

  const anonPayload = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url');
  const anonJwt = `eyJhbGciOiJIUzI1NiJ9.${anonPayload}.sig`;
  assert.throws(
    () => resolveRemoteConfig({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: anonJwt
    }),
    /anon key/i
  );

  const servicePayload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  const serviceJwt = `eyJhbGciOiJIUzI1NiJ9.${servicePayload}.sig`;
  const restCfg = resolveRemoteConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: serviceJwt
  });
  assert.equal(restCfg.driver, 'supabase-rest');
  assert.equal(restCfg.mode, 'supabase');

  const pgCfg = resolveRemoteConfig({
    DATABASE_URL: 'postgresql://postgres.ref:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'
  });
  assert.equal(pgCfg.driver, 'postgres');
  assert.equal(pgCfg.mode, 'supabase');
});

test('Render boots without a persistent disk when Supabase is configured and survives a wiped container', { timeout: 30_000 }, async () => {
  const secretKey = 'sb_secret_test_only_not_real';
  const mockSupabase = await startMockSupabaseServer(secretKey);
  const dir1 = mkdtempSync(path.join(os.tmpdir(), 'rvm-supa-1-'));
  const dir2 = mkdtempSync(path.join(os.tmpdir(), 'rvm-supa-2-'));
  let first;
  let second;

  try {
    const port1 = await freePort();
    first = launchOnRender({
      dataDir: dir1,
      port: port1,
      supabaseUrl: mockSupabase.url,
      supabaseKey: secretKey
    });
    await first.ready;
    const base1 = `http://127.0.0.1:${port1}`;

    const loginRes = await api(base1, '/api/teacher/login', {
      method: 'POST',
      body: { username: 'teacher', password: 'initial-supabase-pass' }
    });
    assert.equal(loginRes.status, 200);
    const teacherToken = loginRes.data.token;

    const storage1 = await api(base1, '/api/teacher/storage', { token: teacherToken });
    assert.equal(storage1.status, 200);
    assert.equal(storage1.data.durable, true);
    assert.equal(storage1.data.mode, 'supabase');

    // Change password, configure exam settings, and replace the question bank.
    const pwChange = await api(base1, '/api/teacher/password', {
      method: 'POST',
      token: teacherToken,
      body: { current: 'initial-supabase-pass', next: 'updated-supabase-pass-2026' }
    });
    assert.equal(pwChange.status, 200);

    const savedSettings = await api(base1, '/api/teacher/settings', {
      method: 'POST',
      token: teacherToken,
      body: {
        exam_title: 'Supabase Durable Midterm',
        access_code: 'SUP-246',
        duration_minutes: 45,
        show_result_to_student: true,
        shuffle_questions: false,
        shuffle_choices: false
      }
    });
    assert.equal(savedSettings.status, 200);
    assert.equal(savedSettings.data.access_code, 'SUP-246');

    const bankImport = await api(base1, '/api/teacher/exam', {
      method: 'POST',
      token: teacherToken,
      rawText: true,
      body: `# Part I. Core\n1. Capital of the Philippines? [3]\nA. Cebu\nB. Manila *\n\n2. Explain photosynthesis briefly. // [5]\n`
    });
    assert.equal(bankImport.status, 200);
    assert.equal(bankImport.data.counts.questions, 2);

    // Second isolated teacher registers.
    const secondTeacher = await api(base1, '/api/teacher/register', {
      method: 'POST',
      body: { username: 'co_teacher', password: 'co-teacher-secure-pass' }
    });
    assert.equal(secondTeacher.status, 201);

    // Student joins, answers both questions, logs a violation, and submits.
    const joinRes = await api(base1, '/api/sessions', {
      method: 'POST',
      body: {
        access_code: 'SUP-246',
        student_name: 'Juan Dela Cruz',
        student_no: '2026-0042',
        class_section: 'BSIT-2A'
      }
    });
    assert.equal(joinRes.status, 201);
    const studentToken = joinRes.data.token;

    await api(base1, `/api/s/${studentToken}/start`, { method: 'POST', body: {} });
    const item0 = (await api(base1, `/api/s/${studentToken}/item?i=0`)).data;
    const manilaChoice = item0.question.choices.find((c) => c.text === 'Manila');
    await api(base1, `/api/s/${studentToken}/answer`, {
      method: 'POST',
      body: { questionId: item0.question.id, value: manilaChoice.key }
    });

    const item1 = (await api(base1, `/api/s/${studentToken}/item?i=1`)).data;
    await api(base1, `/api/s/${studentToken}/answer`, {
      method: 'POST',
      body: { questionId: item1.question.id, value: 'Plants convert light into chemical energy.' }
    });
    await api(base1, `/api/s/${studentToken}/flag`, {
      method: 'POST',
      body: { type: 'copy', detail: 'Copied prompt' }
    });
    const submitRes = await api(base1, `/api/s/${studentToken}/submit`, {
      method: 'POST',
      body: { confirm: true }
    });
    assert.equal(submitRes.status, 200);
    assert.equal(submitRes.data.submitted, true);

    // Teacher grades the essay before Render wipes the container.
    const gradeRes = await api(base1, `/api/teacher/session/${studentToken}/grade`, {
      method: 'POST',
      token: teacherToken,
      body: { questionId: item1.question.id, points: 4, note: 'Clear explanation' }
    });
    assert.equal(gradeRes.status, 200);
    assert.equal(gradeRes.data.grade.score, 7);

    // Test transient outage handling: failed Supabase writes return 503 and leave no ghost student.
    mockSupabase.setFailWrites(true);
    const failedJoin = await api(base1, '/api/sessions', {
      method: 'POST',
      body: {
        access_code: 'SUP-246',
        student_name: 'Retry Student',
        student_no: '2026-9999',
        class_section: 'BSIT-2A'
      }
    });
    assert.equal(failedJoin.status, 503);
    mockSupabase.setFailWrites(false);

    const recoveredJoin = await api(base1, '/api/sessions', {
      method: 'POST',
      body: {
        access_code: 'SUP-246',
        student_name: 'Retry Student',
        student_no: '2026-9999',
        class_section: 'BSIT-2A'
      }
    });
    assert.equal(recoveredJoin.status, 201);

    // Simulate Render terminating the container and wiping its local filesystem completely.
    await stop(first);
    rmSync(dir1, { recursive: true, force: true });

    const port2 = await freePort();
    second = launchOnRender({
      dataDir: dir2,
      port: port2,
      supabaseUrl: mockSupabase.url,
      supabaseKey: secretKey
    });
    await second.ready;
    const base2 = `http://127.0.0.1:${port2}`;

    // Existing teacher token still works across container replacement!
    const storage2 = await api(base2, '/api/teacher/storage', { token: teacherToken });
    assert.equal(storage2.status, 200);
    assert.equal(storage2.data.storageId, storage1.data.storageId);
    assert.equal(storage2.data.mode, 'supabase');

    // Old password fails; updated password works.
    const oldLogin = await api(base2, '/api/teacher/login', {
      method: 'POST',
      body: { username: 'teacher', password: 'initial-supabase-pass' }
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await api(base2, '/api/teacher/login', {
      method: 'POST',
      body: { username: 'teacher', password: 'updated-supabase-pass-2026' }
    });
    assert.equal(newLogin.status, 200);

    // Co-teacher account also survived.
    const coLogin = await api(base2, '/api/teacher/login', {
      method: 'POST',
      body: { username: 'co_teacher', password: 'co-teacher-secure-pass' }
    });
    assert.equal(coLogin.status, 200);

    // Restored exam settings, question bank, graded attempt, events, and released score lookup all match.
    const pubInfo = await api(base2, '/api/public/exam-info?code=SUP-246');
    assert.equal(pubInfo.status, 200);
    assert.equal(pubInfo.data.title, 'Supabase Durable Midterm');
    assert.equal(pubInfo.data.totalQuestions, 2);
    assert.equal(pubInfo.data.totalPoints, 8);

    const lookup = await api(base2, '/api/public/result-lookup', {
      method: 'POST',
      body: { code: 'SUP-246', number: '2026-0042' }
    });
    assert.equal(lookup.status, 200);
    assert.equal(lookup.data.score, 7);
    assert.equal(lookup.data.max, 8);
    assert.equal(lookup.data.pending, 0);

    const detail = await api(base2, `/api/teacher/session/${studentToken}`, { token: teacherToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.session.violations, 1);
    assert.ok(detail.data.events.some((e) => e.type === 'violation:copy'));

    // Duplicate exam, reset attempts on the original, delete the copy, and log out.
    const examsList = await api(base2, '/api/teacher/exams', { token: teacherToken });
    const mainExamId = examsList.data.currentId;
    const dupRes = await api(base2, `/api/teacher/exams/${mainExamId}/duplicate`, {
      method: 'POST',
      token: teacherToken
    });
    assert.equal(dupRes.status, 200);
    const copyId = dupRes.data.exam.id;

    await api(base2, `/api/teacher/exams/${mainExamId}/select`, {
      method: 'POST',
      token: teacherToken
    });
    const resetRes = await api(base2, '/api/teacher/reset-attempts', {
      method: 'POST',
      token: teacherToken,
      body: {}
    });
    assert.equal(resetRes.status, 200);
    assert.equal(mockSupabase.tables.sessions.size, 0);

    const delExamRes = await api(base2, `/api/teacher/exams/${copyId}`, {
      method: 'DELETE',
      token: teacherToken
    });
    assert.equal(delExamRes.status, 200);
    assert.equal(mockSupabase.tables.exams.has(copyId), false);

    const logoutRes = await api(base2, '/api/teacher/logout', {
      method: 'POST',
      token: teacherToken
    });
    assert.equal(logoutRes.status, 200);
    assert.equal(mockSupabase.tables.teacher_tokens.has(teacherToken), false);
  } finally {
    if (first) await stop(first).catch(() => first.child.kill('SIGKILL'));
    if (second) await stop(second).catch(() => second.child.kill('SIGKILL'));
    await mockSupabase.close();
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});
