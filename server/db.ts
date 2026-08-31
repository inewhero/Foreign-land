import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = resolve(process.env.EXPERIMENT_DB ?? "data/experiment.sqlite");
const databaseExisted = existsSync(dbPath);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
db.exec("PRAGMA foreign_keys=ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    room_code TEXT PRIMARY KEY,
    admin_token TEXT NOT NULL,
    status TEXT NOT NULL,
    active_macro_block INTEGER NOT NULL DEFAULT -1,
    access_mode TEXT NOT NULL DEFAULT 'lan',
    wifi_name TEXT NOT NULL DEFAULT '',
    public_base_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS participants (
    participant_id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    room_code TEXT NOT NULL REFERENCES rooms(room_code),
    study_id TEXT NOT NULL,
    resume_token TEXT NOT NULL,
    group_code TEXT NOT NULL DEFAULT '',
    wave_code TEXT NOT NULL DEFAULT 'T0',
    form_code TEXT NOT NULL DEFAULT 'A',
    notes TEXT NOT NULL DEFAULT '',
    assignment_method TEXT NOT NULL DEFAULT '',
    assignment_locked INTEGER NOT NULL DEFAULT 0,
    protocol_version TEXT NOT NULL DEFAULT 'ctp-v2',
    dose_code TEXT NOT NULL DEFAULT 'short96',
    sequence_id TEXT NOT NULL DEFAULT '',
    protocol_deviation INTEGER NOT NULL DEFAULT 0,
    consent_mode TEXT NOT NULL DEFAULT 'full',
    state_json TEXT NOT NULL,
    connected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(room_code, study_id, wave_code)
  ) STRICT;
`);

function columnsOf(table: string) {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
}

function backupBeforeV2Migration() {
  if (!databaseExisted) return;
  db.exec("PRAGMA wal_checkpoint(FULL)");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-v2-${stamp}.sqlite`;
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
}

const participantColumnsBeforeMigration = columnsOf("participants");
if (!participantColumnsBeforeMigration.has("subject_id")) {
  backupBeforeV2Migration();
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS participants_v2_migration;
      CREATE TABLE participants_v2_migration (
        participant_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        room_code TEXT NOT NULL REFERENCES rooms(room_code),
        study_id TEXT NOT NULL,
        resume_token TEXT NOT NULL,
        group_code TEXT NOT NULL DEFAULT '',
        wave_code TEXT NOT NULL DEFAULT 'T0',
        form_code TEXT NOT NULL DEFAULT 'A',
        notes TEXT NOT NULL DEFAULT '',
        assignment_method TEXT NOT NULL DEFAULT '',
        assignment_locked INTEGER NOT NULL DEFAULT 0,
        protocol_version TEXT NOT NULL DEFAULT 'legacy-v1',
        dose_code TEXT NOT NULL DEFAULT 'legacy240',
        sequence_id TEXT NOT NULL DEFAULT 'legacy-v1',
        protocol_deviation INTEGER NOT NULL DEFAULT 0,
        consent_mode TEXT NOT NULL DEFAULT 'full',
        state_json TEXT NOT NULL,
        connected INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(room_code, study_id, wave_code)
      ) STRICT;
      INSERT INTO participants_v2_migration(
        participant_id, subject_id, session_id, room_code, study_id, resume_token,
        group_code, wave_code, form_code, notes, assignment_method, assignment_locked,
        protocol_version, dose_code, sequence_id, protocol_deviation, consent_mode,
        state_json, connected, created_at, updated_at
      )
      SELECT participant_id, 'subject_' || participant_id, participant_id, room_code, study_id, resume_token,
        group_code, CASE WHEN wave_code='' THEN 'T0' ELSE wave_code END, form_code, notes,
        assignment_method, assignment_locked, 'legacy-v1', 'legacy240', 'legacy-v1', 0, 'full',
        state_json, connected, created_at, updated_at
      FROM participants;
      DROP TABLE participants;
      ALTER TABLE participants_v2_migration RENAME TO participants;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve migration error */ }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS subjects (
    subject_id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL REFERENCES rooms(room_code),
    study_id TEXT NOT NULL,
    group_code TEXT NOT NULL DEFAULT '实验',
    dose_code TEXT NOT NULL DEFAULT 'short96',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(room_code, study_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS assessment_sessions (
    session_id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL REFERENCES subjects(subject_id),
    participant_id TEXT NOT NULL UNIQUE REFERENCES participants(participant_id),
    room_code TEXT NOT NULL REFERENCES rooms(room_code),
    wave_code TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    dose_code TEXT NOT NULL,
    form_code TEXT NOT NULL,
    sequence_id TEXT NOT NULL,
    status TEXT NOT NULL,
    protocol_deviation INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(subject_id, wave_code)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS audit_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    participant_id TEXT,
    actor TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS consents (
    participant_id TEXT PRIMARY KEY REFERENCES participants(participant_id),
    room_code TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    signed_as TEXT NOT NULL,
    signature_data TEXT,
    accepted INTEGER NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS participant_events (
    client_event_id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL REFERENCES participants(participant_id),
    room_code TEXT NOT NULL,
    study_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    round_id TEXT,
    event_type TEXT NOT NULL,
    phase TEXT,
    client_time TEXT NOT NULL,
    client_monotonic_ms REAL NOT NULL,
    visibility_state TEXT NOT NULL,
    fullscreen INTEGER NOT NULL,
    online INTEGER NOT NULL,
    viewport_width INTEGER NOT NULL,
    viewport_height INTEGER NOT NULL,
    screen_width INTEGER NOT NULL,
    screen_height INTEGER NOT NULL,
    device_pixel_ratio REAL NOT NULL,
    payload_json TEXT NOT NULL,
    server_received_at TEXT NOT NULL
  ) STRICT;
`);

const trialTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trials'").get());
const trialColumnsBeforeMigration = trialTableExists ? columnsOf("trials") : new Set<string>();
if (trialTableExists && !trialColumnsBeforeMigration.has("protocol_version")) {
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS trials_v2_migration;
      CREATE TABLE trials_v2_migration (
        round_id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL REFERENCES participants(participant_id),
        subject_id TEXT, session_id TEXT, room_code TEXT NOT NULL, study_id TEXT NOT NULL,
        group_code TEXT NOT NULL, wave_code TEXT NOT NULL, form_code TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
        protocol_version TEXT NOT NULL DEFAULT 'legacy-v1', dose_code TEXT NOT NULL DEFAULT 'legacy240',
        sequence_id TEXT NOT NULL DEFAULT 'legacy-v1', trial_template_id TEXT, anchor_id TEXT,
        evidence_class TEXT, social_regime TEXT, social_value_short REAL, social_value_long REAL,
        social_value_mean REAL, social_value_contrast REAL, personal_value_basis REAL, previous_choice REAL,
        protocol_deviation INTEGER NOT NULL DEFAULT 0, macro_block INTEGER NOT NULL, region_theme TEXT,
        game_key TEXT NOT NULL, location_name TEXT NOT NULL, companion_label TEXT NOT NULL, guardian_label TEXT,
        companion_challenger_label TEXT, participant_challenger_label TEXT, companion_ordinal INTEGER NOT NULL,
        bot_level TEXT, bot_beta REAL, delay_profile TEXT, valid_round INTEGER NOT NULL,
        previous_participant_action TEXT, previous_companion_action TEXT, companion_action TEXT NOT NULL,
        companion_route_action TEXT, companion_display_points INTEGER, switch_probability REAL, delta_payoff REAL,
        prediction_action TEXT, prediction_rt_ms INTEGER, prediction_timed_out INTEGER NOT NULL DEFAULT 0,
        participant_action TEXT NOT NULL, participant_route_action TEXT, choice_rt_ms INTEGER NOT NULL,
        normalized_payoff REAL NOT NULL, display_points INTEGER NOT NULL, cumulative_points INTEGER NOT NULL,
        intended_delay_ms INTEGER NOT NULL, actual_delay_ms INTEGER NOT NULL, random_seed TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO trials_v2_migration(
        round_id, participant_id, subject_id, session_id, room_code, study_id, group_code, wave_code, form_code, notes,
        protocol_version, dose_code, sequence_id, macro_block, region_theme, game_key, location_name, companion_label,
        guardian_label, companion_challenger_label, participant_challenger_label, companion_ordinal, bot_level, bot_beta,
        delay_profile, valid_round, previous_participant_action, previous_companion_action, companion_action,
        companion_route_action, companion_display_points, switch_probability, delta_payoff, prediction_action,
        prediction_rt_ms, prediction_timed_out, participant_action, participant_route_action, choice_rt_ms,
        normalized_payoff, display_points, cumulative_points, intended_delay_ms, actual_delay_ms, random_seed, created_at
      )
      SELECT t.round_id, t.participant_id, p.subject_id, p.session_id, t.room_code, t.study_id, t.group_code, t.wave_code,
        t.form_code, t.notes, 'legacy-v1', 'legacy240', 'legacy-v1', t.macro_block, t.region_theme, t.game_key,
        t.location_name, t.companion_label, t.guardian_label, t.companion_challenger_label, t.participant_challenger_label,
        t.companion_ordinal, t.bot_level, t.bot_beta, t.delay_profile, t.valid_round, t.previous_participant_action,
        t.previous_companion_action, t.companion_action, t.companion_route_action, t.companion_display_points,
        t.switch_probability, t.delta_payoff, t.prediction_action, t.prediction_rt_ms, t.prediction_timed_out,
        t.participant_action, t.participant_route_action, t.choice_rt_ms, t.normalized_payoff, t.display_points,
        t.cumulative_points, t.intended_delay_ms, t.actual_delay_ms, t.random_seed, t.created_at
      FROM trials t LEFT JOIN participants p ON p.participant_id=t.participant_id;
      DROP TABLE trials;
      ALTER TABLE trials_v2_migration RENAME TO trials;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve migration error */ }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS trials (
    round_id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(participant_id),
    subject_id TEXT, session_id TEXT, room_code TEXT NOT NULL, study_id TEXT NOT NULL,
    group_code TEXT NOT NULL, wave_code TEXT NOT NULL, form_code TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    protocol_version TEXT NOT NULL DEFAULT 'ctp-v2', dose_code TEXT NOT NULL DEFAULT 'short96',
    sequence_id TEXT NOT NULL, trial_template_id TEXT, anchor_id TEXT, evidence_class TEXT, social_regime TEXT,
    social_value_short REAL, social_value_long REAL, social_value_mean REAL, social_value_contrast REAL,
    personal_value_basis REAL, previous_choice REAL, protocol_deviation INTEGER NOT NULL DEFAULT 0,
    macro_block INTEGER NOT NULL, region_theme TEXT, game_key TEXT NOT NULL, location_name TEXT NOT NULL,
    companion_label TEXT NOT NULL, guardian_label TEXT, companion_challenger_label TEXT,
    participant_challenger_label TEXT, companion_ordinal INTEGER NOT NULL, bot_level TEXT, bot_beta REAL,
    delay_profile TEXT, valid_round INTEGER NOT NULL, previous_participant_action TEXT,
    previous_companion_action TEXT, companion_action TEXT NOT NULL, companion_route_action TEXT,
    companion_display_points INTEGER, switch_probability REAL, delta_payoff REAL, prediction_action TEXT,
    prediction_rt_ms INTEGER, prediction_timed_out INTEGER NOT NULL DEFAULT 0, participant_action TEXT NOT NULL,
    participant_route_action TEXT, choice_rt_ms INTEGER NOT NULL, normalized_payoff REAL NOT NULL,
    display_points INTEGER NOT NULL, cumulative_points INTEGER NOT NULL, intended_delay_ms INTEGER NOT NULL,
    actual_delay_ms INTEGER NOT NULL, random_seed TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
`);

for (const [table, name, type] of [
  ["consents", "subject_id", "TEXT"],
  ["consents", "assessment_session_id", "TEXT"],
  ["consents", "consent_mode", "TEXT NOT NULL DEFAULT 'full'"],
  ["participant_events", "assessment_session_id", "TEXT"],
] as const) {
  if (!columnsOf(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

db.exec(`
  INSERT OR IGNORE INTO subjects(subject_id, room_code, study_id, group_code, dose_code, created_at, updated_at)
  SELECT subject_id, room_code, study_id, CASE WHEN group_code='' THEN '实验' ELSE group_code END, dose_code, created_at, updated_at
  FROM participants;
  INSERT OR IGNORE INTO assessment_sessions(
    session_id, subject_id, participant_id, room_code, wave_code, protocol_version, dose_code,
    form_code, sequence_id, status, protocol_deviation, state_json, created_at, updated_at
  )
  SELECT session_id, subject_id, participant_id, room_code, wave_code, protocol_version, dose_code,
    form_code, sequence_id, COALESCE(json_extract(state_json, '$.status'), 'lobby'), protocol_deviation,
    state_json, created_at, updated_at FROM participants;
  CREATE INDEX IF NOT EXISTS idx_trials_participant_condition ON trials(participant_id, macro_block, companion_ordinal, valid_round);
  CREATE INDEX IF NOT EXISTS idx_trials_session ON trials(session_id, valid_round);
  CREATE INDEX IF NOT EXISTS idx_participants_room_status ON participants(room_code, connected);
  CREATE INDEX IF NOT EXISTS idx_sessions_subject_wave ON assessment_sessions(subject_id, wave_code);
  CREATE INDEX IF NOT EXISTS idx_audit_room_time ON audit_events(room_code, created_at);
  CREATE INDEX IF NOT EXISTS idx_participant_events_room_time ON participant_events(room_code, server_received_at);
  CREATE INDEX IF NOT EXISTS idx_participant_events_round ON participant_events(participant_id, round_id, sequence);
  PRAGMA user_version=2;
  PRAGMA optimize;
`);

const foreignKeyProblems = db.prepare("PRAGMA foreign_key_check").all();
if (foreignKeyProblems.length) throw new Error(`数据库 v2 迁移后发现 ${foreignKeyProblems.length} 个外键问题`);

export const nowIso = () => new Date().toISOString();

export function audit(roomCode: string, actor: string, eventType: string, payload: unknown, participantId?: string) {
  db.prepare(`
    INSERT INTO audit_events(room_code, participant_id, actor, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(roomCode, participantId ?? null, actor, eventType, JSON.stringify(payload), nowIso());
}
