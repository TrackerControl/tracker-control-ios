const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MIGRATION_LOCK_KEYS,
  main,
  runMigrations
} = require('../scripts/migrate');

const createMigrationsDir = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const [filename, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filename), sql);
  }
  return dir;
};

const silentLogger = {
  log() {}
};

test('holds the advisory lock across migration discovery and application', async (t) => {
  const migrationsDir = createMigrationsDir({
    '001_applied.sql': 'SELECT 1',
    '002_pending.sql': 'SELECT 2'
  });
  t.after(() => fs.rmSync(migrationsDir, { recursive: true, force: true }));

  const queries = [];
  const client = {
    async query(sql, params) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalizedSql, params });
      if (normalizedSql === 'SELECT filename FROM schema_migrations') {
        return { rows: [{ filename: '001_applied.sql' }] };
      }
      return { rows: [] };
    }
  };

  const logs = [];
  await runMigrations(client, migrationsDir, {
    log(message) {
      logs.push(message);
    }
  });

  assert.deepEqual(queries[0], {
    sql: 'SELECT pg_advisory_lock($1, $2)',
    params: MIGRATION_LOCK_KEYS
  });
  assert.match(queries[1].sql, /^CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.deepEqual(
    queries.slice(2).map(({ sql }) => sql),
    [
      'SELECT filename FROM schema_migrations',
      'BEGIN',
      'SELECT 2',
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      'COMMIT',
      'SELECT pg_advisory_unlock($1, $2)'
    ]
  );
  assert.deepEqual(queries.at(-1).params, MIGRATION_LOCK_KEYS);
  assert.equal(logs[0], 'Waiting for migration advisory lock');
  assert.match(logs[1], /^Acquired migration advisory lock after \d+ms$/);
  assert.deepEqual(logs.slice(-2), [
    'Releasing migration advisory lock',
    'Released migration advisory lock'
  ]);
});

test('rolls back and releases the advisory lock when a migration fails', async (t) => {
  const migrationsDir = createMigrationsDir({
    '001_fails.sql': 'INVALID MIGRATION'
  });
  t.after(() => fs.rmSync(migrationsDir, { recursive: true, force: true }));

  const queries = [];
  const client = {
    async query(sql) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      queries.push(normalizedSql);
      if (normalizedSql === 'SELECT filename FROM schema_migrations') {
        return { rows: [] };
      }
      if (normalizedSql === 'INVALID MIGRATION') {
        throw new Error('migration failed');
      }
      return { rows: [] };
    }
  };

  await assert.rejects(
    runMigrations(client, migrationsDir, silentLogger),
    /migration failed/
  );

  assert.deepEqual(queries.slice(-2), [
    'ROLLBACK',
    'SELECT pg_advisory_unlock($1, $2)'
  ]);
});

test('main closes the database client after migration failure', async (t) => {
  const migrationsDir = createMigrationsDir({
    '001_fails.sql': 'INVALID MIGRATION'
  });
  t.after(() => fs.rmSync(migrationsDir, { recursive: true, force: true }));

  const events = [];
  class FakeClient {
    constructor(options) {
      events.push(['constructed', options]);
    }

    async connect() {
      events.push(['connect']);
    }

    async query(sql) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      events.push(['query', normalizedSql]);
      if (normalizedSql === 'SELECT filename FROM schema_migrations') {
        return { rows: [] };
      }
      if (normalizedSql === 'INVALID MIGRATION') {
        throw new Error('migration failed');
      }
      return { rows: [] };
    }

    async end() {
      events.push(['end']);
    }
  }

  await assert.rejects(
    main({
      databaseUrl: 'postgres://example/test',
      migrationsDir,
      ClientClass: FakeClient,
      logger: silentLogger
    }),
    /migration failed/
  );

  assert.deepEqual(events.at(-1), ['end']);
  assert.equal(
    events.some((event) => event[0] === 'query' && event[1] === 'SELECT pg_advisory_unlock($1, $2)'),
    true
  );
});

test('main closes the database client after successful migrations', async (t) => {
  const migrationsDir = createMigrationsDir({});
  t.after(() => fs.rmSync(migrationsDir, { recursive: true, force: true }));

  const events = [];
  class FakeClient {
    async connect() {
      events.push('connect');
    }

    async query(sql) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      events.push(normalizedSql);
      if (normalizedSql === 'SELECT filename FROM schema_migrations') {
        return { rows: [] };
      }
      return { rows: [] };
    }

    async end() {
      events.push('end');
    }
  }

  await main({
    databaseUrl: 'postgres://example/test',
    migrationsDir,
    ClientClass: FakeClient,
    logger: silentLogger
  });

  assert.equal(events[0], 'connect');
  assert.equal(events.at(-2), 'SELECT pg_advisory_unlock($1, $2)');
  assert.equal(events.at(-1), 'end');
});

test('main closes the database client after connect failure', async () => {
  const events = [];
  class FakeClient {
    async connect() {
      events.push('connect');
      throw new Error('connect failed');
    }

    async end() {
      events.push('end');
    }
  }

  await assert.rejects(
    main({
      databaseUrl: 'postgres://example/test',
      ClientClass: FakeClient,
      logger: silentLogger
    }),
    /connect failed/
  );

  assert.deepEqual(events, ['connect', 'end']);
});
