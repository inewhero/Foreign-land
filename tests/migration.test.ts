import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
    copyFileSync(new URL("../data/e2e-subagent-run.sqlite", import.meta.url), databasePath);
    const moduleUrl = pathToFileURL(resolve("server/db.ts")).href;
    execFileSync(process.execPath, [
      "--experimental-strip-types",
      "-e",
      `import(${JSON.stringify(moduleUrl)}).then(({db})=>db.close())`,
    ], { env: { ...process.env, EXPERIMENT_DB: databasePath }, stdio: "pipe" });
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    const participantCount = (migrated.prepare("SELECT COUNT(*) AS count FROM participants").get() as { count: number }).count;
    assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM subjects").get() as { count: number }).count, participantCount);
    assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM assessment_sessions").get() as { count: number }).count, participantCount);
    assert.deepEqual(
      migrated.prepare("SELECT DISTINCT protocol_version, dose_code FROM participants").all().map((row) => ({ ...(row as Record<string, unknown>) })),
      [{ protocol_version: "legacy-v1", dose_code: "legacy240" }],
    );
    migrated.close();
    assert.ok(readdirSync(tempRoot).some((name) => name.includes(".pre-v2-") && name.endsWith(".sqlite")));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
