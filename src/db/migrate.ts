import { pool } from "./pool";

const DDL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS trip_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    region          VARCHAR(200),
    trip_type       VARCHAR(50),
    fish_species    TEXT[],
    name            VARCHAR(300) NOT NULL,
    description     TEXT,
    template_data   JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN DEFAULT TRUE,
    usage_count     INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_region ON trip_templates(region);

CREATE TABLE IF NOT EXISTS trip_projects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug            VARCHAR(100) NOT NULL UNIQUE,
    user_id         VARCHAR(100) NOT NULL,
    scout_id        VARCHAR(50),
    title           VARCHAR(300) NOT NULL,
    status          VARCHAR(30) NOT NULL DEFAULT 'draft',
    description     TEXT,
    cover_image_url VARCHAR(500),
    region          VARCHAR(200),
    country         VARCHAR(100),
    latitude        DECIMAL(10,6),
    longitude       DECIMAL(10,6),
    dates_start     DATE,
    dates_end       DATE,
    target_species  TEXT[],
    trip_type       VARCHAR(50),
    budget_min      INTEGER,
    budget_max      INTEGER,
    participants_count INTEGER DEFAULT 1,
    experience_level VARCHAR(30),
    special_requirements TEXT,
    itinerary       JSONB DEFAULT '[]',
    template_id     UUID REFERENCES trip_templates(id),
    payment_status  VARCHAR(30) DEFAULT 'unpaid',
    payment_id      VARCHAR(200),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON trip_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON trip_projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON trip_projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_user_status ON trip_projects(user_id, status);

CREATE TABLE IF NOT EXISTS trip_participants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES trip_projects(id) ON DELETE CASCADE,
    user_id         VARCHAR(100),
    name            VARCHAR(200) NOT NULL,
    email           VARCHAR(200),
    telegram_id     VARCHAR(50),
    whatsapp_phone  VARCHAR(30),
    preferred_channel VARCHAR(20) DEFAULT 'email',
    role            VARCHAR(20) NOT NULL DEFAULT 'participant',
    status          VARCHAR(20) NOT NULL DEFAULT 'invited',
    invite_token    VARCHAR(100) UNIQUE,
    invite_sent_at  TIMESTAMPTZ,
    joined_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_participants_project ON trip_participants(project_id);

CREATE TABLE IF NOT EXISTS trip_tasks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES trip_projects(id) ON DELETE CASCADE,
    type            VARCHAR(30) NOT NULL,
    title           VARCHAR(300) NOT NULL,
    description     TEXT,
    assigned_to     UUID REFERENCES trip_participants(id),
    deadline        TIMESTAMPTZ,
    sort_order      INTEGER DEFAULT 0,
    status          VARCHAR(30) NOT NULL DEFAULT 'pending',
    completed_at    TIMESTAMPTZ,
    automation_mode VARCHAR(20) DEFAULT 'remind',
    reminder_schedule VARCHAR(50),
    last_reminder_at TIMESTAMPTZ,
    next_reminder_at TIMESTAMPTZ,
    vendor_record_id VARCHAR(50),
    vendor_name      VARCHAR(200),
    depends_on      UUID[],
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON trip_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON trip_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON trip_tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON trip_tasks(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON trip_tasks(project_id, status);

CREATE TABLE IF NOT EXISTS trip_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES trip_projects(id) ON DELETE CASCADE,
    event_type      VARCHAR(50) NOT NULL,
    actor           VARCHAR(20) NOT NULL,
    actor_id        VARCHAR(100),
    payload         JSONB NOT NULL DEFAULT '{}',
    entity_type     VARCHAR(30),
    entity_id       UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_project ON trip_events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_project_created ON trip_events(project_id, created_at);

CREATE TABLE IF NOT EXISTS trip_media (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES trip_projects(id) ON DELETE CASCADE,
    user_id         VARCHAR(100),
    type            VARCHAR(20) NOT NULL DEFAULT 'photo',
    url             VARCHAR(500) NOT NULL,
    thumbnail_url   VARCHAR(500),
    caption         TEXT,
    sort_order      INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_project ON trip_media(project_id);

CREATE TABLE IF NOT EXISTS trip_locations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES trip_projects(id) ON DELETE CASCADE,
    name            VARCHAR(300) NOT NULL,
    type            VARCHAR(30) NOT NULL DEFAULT 'point',
    latitude        DECIMAL(10,6) NOT NULL,
    longitude       DECIMAL(10,6) NOT NULL,
    day_number      INTEGER,
    sort_order      INTEGER DEFAULT 0,
    vendor_record_id VARCHAR(50),
    notes           TEXT,
    image_url       VARCHAR(500),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_locations_project ON trip_locations(project_id);
CREATE INDEX IF NOT EXISTS idx_locations_project_day ON trip_locations(project_id, day_number);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_updated') THEN
    CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON trip_projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tasks_updated') THEN
    CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON trip_tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_participants_updated') THEN
    CREATE TRIGGER trg_participants_updated BEFORE UPDATE ON trip_participants FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_templates_updated') THEN
    CREATE TRIGGER trg_templates_updated BEFORE UPDATE ON trip_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;
`;

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(DDL);
    console.log("[DB] Migrations complete — 7 tables ready");
  } catch (err: any) {
    console.error("[DB] Migration error:", err.message);
    throw err;
  } finally {
    client.release();
  }
}
