import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("legacy database migration creates subjects, longitudinal sessions, and a backup", () => {
  const tempRoot = resolve(mkdtempSync(join(tmpdir(), "choice-onsite-v2-")));
  assert.ok(tempRoot.startsWith(resolve(tmpdir())));
  const databasePath = join(tempRoot, "legacy.sqlite");
  try {
    // Build a synthetic v1 database: CI must not depend on local participant data.
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        PRAGMA user_version=1;
        CREATE TABLE rooms (
          room_code TEXT PRIMARY KEY, admin_token TEXT NOT NULL, status TEXT NOT NULL,
          active_macro_block INTEGER NOT NULL DEFAULT -1,
          access_mode TEXT NOT NULL DEFAULT 'lan', wifi_name TEXT NOT NULL DEFAULT '',
          public_base_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE participants (
          participant_id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(room_code),
          study_id TEXT NOT NULL, resume_token TEXT NOT NULL, group_code TEXT NOT NULL DEFAULT '',
          wave_code TEXT NOT NULL DEFAULT '', form_code TEXT NOT NULL DEFAULT 'A',
          notes TEXT NOT NULL DEFAULT '', assignment_method TEXT NOT NULL DEFAULT '',
          assignment_locked INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL,
          connected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(room_code, study_id)
        ) STRICT;
        INSERT INTO rooms(room_code, admin_token, status, created_at, updated_at)
        VALUES ('fixture-room', 'fixture-admin', 'lobby', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
        INSERT INTO participants(participant_id, room_code, study_id, resume_token, state_json, created_at, updated_at)
        VALUES ('fixture-p1', 'fixture-room', 'fixture-study-1', 'fixture-resume-1', '{"status":"lobby"}',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
        INSERT INTO participants(participant_id, room_code, study_id, resume_token, wave_code, state_json, created_at, updated_at)
        VALUES ('fixture-p2', 'fixture-room', 'fixture-study-2', 'fixture-resume-2', 'T1', '{"status":"completed"}',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
      `);
    } finally {
      legacy.close();
    }
    const moduleUrl = pathToFileURL(resolve("server/db.ts")).href;
    execFileSync(process.execPath, [
      "--experimental-strip-types",
      "-e",
      `import(${JSON.stringify(moduleUrl)}).then(({db})=>db.close())`,
    ], { env: { ...process.env, EXPERIMENT_DB: databasePath }, stdio: "pipe" });
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    const participantCount = (migrated.prepare("SELECT COUNT(*) AS count FROM participants").get() as { count: number }).count;
    assert.equal(participantCount, 2);
    assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM subjects").get() as { count: number }).count, participantCount);
    assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM assessment_sessions").get() as { count: number }).count, participantCount);
    assert.deepEqual(
      migrated.prepare("SELECT DISTINCT protocol_version, dose_code FROM participants").all().map((row) => ({ ...(row as Record<string, unknown>) })),
      [{ protocol_version: "legacy-v1", dose_code: "legacy240" }],
    );
    assert.deepEqual(
      migrated.prepare("SELECT participant_id, subject_id, session_id, wave_code FROM participants ORDER BY participant_id").all().map((row) => ({ ...row })),
      [
        { participant_id: "fixture-p1", subject_id: "subject_fixture-p1", session_id: "fixture-p1", wave_code: "T0" },
        { participant_id: "fixture-p2", subject_id: "subject_fixture-p2", session_id: "fixture-p2", wave_code: "T1" },
      ],
    );
    assert.deepEqual(
      migrated.prepare("SELECT status FROM assessment_sessions ORDER BY participant_id").all().map((row) => row.status),
      ["lobby", "completed"],
    );
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    migrated.close();
    assert.ok(readdirSync(tempRoot).some((name) => name.includes(".pre-v2-") && name.endsWith(".sqlite")));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
