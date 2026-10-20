-- When the analyser last checked in. Kept in the database so a restarted or
-- woken web process still knows the analyser is online.

CREATE TABLE IF NOT EXISTS analyser_heartbeat (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    last_seen timestamptz NOT NULL
);
