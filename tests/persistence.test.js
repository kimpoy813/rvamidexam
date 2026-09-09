import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function launch(dataDir, port) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      EXAM_DATA_DIR: dataDir,
      EXAM_DB: path.join(dataDir, 'restart.sqlite'),
      EXAM_TEACHER_PASSWORD: 'restart-test-pass',
      EXAM_STORAGE_MODE: 'persistent'
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

async function request(base, url, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { 'X-Teacher-Token': token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json();
  assert.equal(res.ok, true, `${method} ${url}: ${data.error || res.status}`);
  return data;
}

async function login(base) {
  return (await request(base, '/api/teacher/login', {
    method: 'POST',
    body: { username: 'teacher', password: 'restart-test-pass' }
  })).token;
}

async function stop(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, 'exit');
  server.child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(signal, null, `server was killed by ${signal}:\n${server.output()}`);
  assert.equal(code, 0, `server shutdown failed:\n${server.output()}`);
}

test('exam setup survives a full server stop and restart', { timeout: 25_000 }, async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'rvm-restart-'));
  let first;
  let second;
  try {
    const firstPort = await freePort();
    first = launch(dataDir, firstPort);
    await first.ready;
    const firstBase = `http://127.0.0.1:${firstPort}`;
    const firstToken = await login(firstBase);
    const beforeStorage = await request(firstBase, '/api/teacher/storage', { token: firstToken });

    const marker = `Restart-safe setup ${Date.now()}`;
    const saved = await request(firstBase, '/api/teacher/settings', {
      method: 'POST',
      token: firstToken,
      body: {
        exam_title: marker,
        school: 'RVM persistence school',
        subject: 'Database durability',
        term: 'Restart regression',
        duration_minutes: 137,
        instructions: 'These instructions must survive SIGTERM.',
        proctor_notes: 'Saved before process restart.',
        max_violations: 17,
        auto_submit_on_violations: false,
        exam_open: false,
        show_result_to_student: true,
        shuffle_questions: false,
        shuffle_choices: false,
        lock_sections: true,
        require_fullscreen: true,
        allow_resume: false
      }
    });
    assert.equal(saved.exam_title, marker);
    assert.equal(saved.duration_minutes, '137');

    // This is the same stop signal used by Render for sleeps, deploys, and restarts.
    await stop(first);

    const secondPort = await freePort();
    second = launch(dataDir, secondPort);
    await second.ready;
    const secondBase = `http://127.0.0.1:${secondPort}`;
    const secondToken = await login(secondBase);
    const restored = await request(secondBase, '/api/teacher/settings', { token: secondToken });
    const afterStorage = await request(secondBase, '/api/teacher/storage', { token: secondToken });

    assert.equal(afterStorage.storageId, beforeStorage.storageId, 'the same SQLite store should reopen');
    assert.equal(restored.exam_title, marker);
    assert.equal(restored.school, 'RVM persistence school');
    assert.equal(restored.subject, 'Database durability');
    assert.equal(restored.term, 'Restart regression');
    assert.equal(restored.duration_minutes, '137');
    assert.equal(restored.instructions, 'These instructions must survive SIGTERM.');
    assert.equal(restored.proctor_notes, 'Saved before process restart.');
    assert.equal(restored.max_violations, '17');
    assert.equal(restored.exam_open, '0');
    assert.equal(restored.show_result_to_student, '1');
    assert.equal(restored.lock_sections, '1');
    assert.equal(restored.require_fullscreen, '1');
    assert.equal(restored.allow_resume, '0');

    const publicInfo = await request(secondBase, '/api/public/exam-info');
    assert.equal(publicInfo.title, marker, 'public entry screen should use the restored title');
  } finally {
    if (first) await stop(first).catch(() => first.child.kill('SIGKILL'));
    if (second) await stop(second).catch(() => second.child.kill('SIGKILL'));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
