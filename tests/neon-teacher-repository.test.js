import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { initializeNeon } from '../server/neon/database.js';
import { registerTeacher, verifyTeacher, issueTeacherToken, teacherFromToken, revokeTeacherToken } from '../server/neon/teacher-repository.js';

const url = process.env.TEST_DATABASE_URL;
test('PostgreSQL teachers are isolated, case-insensitive, and use hashed credentials', {skip:!url,timeout:30000}, async () => {
  const schema = 'test_' + crypto.randomBytes(8).toString('hex');
  const admin = new pg.Client({connectionString:url}); await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const connection = new URL(url); connection.searchParams.set('options', `-csearch_path=${schema}`);
  const pool = new pg.Pool({connectionString:connection.toString()});
  try {
    await initializeNeon(pool);
    await assert.rejects(registerTeacher(pool,'x','short'), {status:400});
    const t=await registerTeacher(pool,'TeacherOne','strong-password-one');
    const other=await registerTeacher(pool,'TeacherTwo','strong-password-two');
    await assert.rejects(registerTeacher(pool,'teacherone','strong-password-one'), {status:409});
    assert.deepEqual(await verifyTeacher(pool,'TEACHERONE','strong-password-one'),t);
    assert.equal(await verifyTeacher(pool,'TeacherOne','wrong'),null);
    const token=await issueTeacherToken(pool,t.id), otherToken=await issueTeacherToken(pool,other.id);
    assert.deepEqual(await teacherFromToken(pool,token),t);
    assert.deepEqual(await teacherFromToken(pool,otherToken),other);
    assert.equal(await teacherFromToken(pool,'garbage'),null);
    const stored=await pool.query('SELECT token FROM teacher_tokens WHERE teacher_id=$1',[t.id]);
    assert.notEqual(stored.rows[0].token,token);
    await revokeTeacherToken(pool,token);
    assert.equal(await teacherFromToken(pool,token),null);
    assert.deepEqual(await teacherFromToken(pool,otherToken),other);
  } finally {await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
