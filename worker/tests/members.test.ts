import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('membership SQL is private, idempotent, and enforces owner constraints', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    const sql = await readFile(new URL('../../supabase/members.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    const before = await db.query<{owner_id: string}>("select owner_id from prism_members where email='deepesh.dutta@gmail.com'");
    await db.exec("update prism_members set active=false where email='deepesh.dutta@gmail.com'");
    await db.exec(sql);
    const after = await db.query<{owner_id: string,active: boolean}>("select owner_id,active from prism_members where email='deepesh.dutta@gmail.com'");
    assert.equal(after.rows[0].owner_id, before.rows[0].owner_id);
    assert.equal(after.rows[0].active, false);
    await db.exec("insert into prism_members(email,access_subject) values ('second@example.com','subject-2')");
    const owners = await db.query<{owner_id: string}>('select owner_id from prism_members');
    assert.equal(new Set(owners.rows.map(r => r.owner_id)).size, 2);
    for (const invalid of [
      "insert into prism_members(email) values ('UPPER@example.com')",
      "insert into prism_members(email) values ('invalid')",
      "insert into prism_members(email,role) values ('third@example.com','superuser')",
      "insert into prism_members(email,access_subject) values ('third@example.com','subject-2')",
      "insert into prism_members(email) values ('second@example.com')",
    ]) await assert.rejects(db.exec(invalid));
    const rls = await db.query<{relrowsecurity: boolean}>("select relrowsecurity from pg_class where oid='prism_members'::regclass");
    assert.equal(rls.rows[0].relrowsecurity, true);
    const policies = await db.query("select * from pg_policies where tablename='prism_members'");
    assert.equal(policies.rows.length, 0);
    for (const role of ['anon','authenticated']) {
      for (const privilege of ['SELECT','INSERT','UPDATE','DELETE']) {
        const grants = await db.query<{allowed: boolean}>(`select has_table_privilege('${role}', 'prism_members', '${privilege}') as allowed`);
        assert.equal(grants.rows[0].allowed, false);
      }
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from prism_members'));
      await db.exec('reset role');
    }
  } finally { await db.close(); }
});
