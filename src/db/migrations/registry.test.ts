import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Migration } from './index.js';

let closeCurrentDb: (() => void) | undefined;

afterEach(() => {
  closeCurrentDb?.();
  closeCurrentDb = undefined;
});

function testMigration(name: string, table = name.replaceAll('-', '_')): Migration {
  return {
    version: 999,
    name,
    up(db) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    },
  };
}

async function freshRegistry() {
  vi.resetModules();
  return import('./index.js');
}

async function freshTestDb() {
  const connection = await import('../connection.js');
  const db = connection.initTestDb();
  closeCurrentDb = connection.closeDb;
  return db;
}

describe('module migration registry', () => {
  it('keeps built-ins first and module migrations in registration order', async () => {
    const registry = await freshRegistry();
    const first = testMigration('test-module-first');
    const second = testMigration('test-module-second');

    registry.registerMigration(first);
    registry.registerMigration(second);

    expect(registry.getRegisteredMigrations()).toEqual([...registry.migrations, first, second]);
  });

  it('rejects names already used by a built-in migration', async () => {
    const registry = await freshRegistry();
    const duplicate = testMigration(registry.migrations[0]!.name);

    expect(() => registry.registerMigration(duplicate)).toThrow(
      `Migration "${registry.migrations[0]!.name}" already registered`,
    );
  });

  it('rejects duplicate module migration names', async () => {
    const registry = await freshRegistry();
    registry.registerMigration(testMigration('test-module-duplicate', 'test_module_duplicate_first'));

    expect(() =>
      registry.registerMigration(testMigration('test-module-duplicate', 'test_module_duplicate_second')),
    ).toThrow('Migration "test-module-duplicate" already registered');
  });

  it('applies and records registered migrations with the default run', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    registry.registerMigration(testMigration('test-module-applied'));

    registry.runMigrations(db);

    expect(db.prepare("SELECT name FROM schema_version WHERE name = 'test-module-applied'").get()).toEqual({
      name: 'test-module-applied',
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_module_applied'").get(),
    ).toEqual({ name: 'test_module_applied' });
  });

  it('preserves the explicit migration-list override', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    const explicit = testMigration('test-explicit-only');
    registry.registerMigration(testMigration('test-module-not-selected'));

    registry.runMigrations(db, [explicit]);

    expect(db.prepare('SELECT name FROM schema_version ORDER BY version').all()).toEqual([
      { name: 'test-explicit-only' },
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_module_not_selected'").get(),
    ).toBeUndefined();
  });
});
