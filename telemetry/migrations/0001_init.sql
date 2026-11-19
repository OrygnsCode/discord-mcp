-- Counts per UTC day. Every value is one of a fixed list or a band, so a
-- row can never hold anything that identifies an install.
--
--   metric          key
--   pings           ''                      reports received that day
--   version, os, app, install, ctx, country, bots, servers, largest, age
--                   the value
--   first_week, first_month, first_ever
--                   ''                      installs whose first active
--                                           day of that span this was
--   reports         ''                      installs whose counts for that
--                                           day arrived (day = the day used)
--   tool            name|band               installs that called the tool
--   gate            event|band              previews, confirmations, declines
--   error           class|band              failed calls by class
--   active_app      app                     AI apps used that day
--   dev_pings       ''                      reports from source checkouts,
--                                           counted apart from everything
--   setup           flow|outcome            wizard runs
--   setup_app       app                     where the wizard registered it
--   setup_version, setup_os, setup_install  the value
CREATE TABLE daily (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, metric, key)
) WITHOUT ROWID;

-- Each report's random number, so a report sent again is counted once.
-- fresh is 1 while the first copy is being counted and 0 once the same
-- number comes again. Pruned after three days; nothing links one day's
-- number to another's.
CREATE TABLE nonces (
  nonce TEXT PRIMARY KEY,
  seen TEXT NOT NULL,
  fresh INTEGER NOT NULL
) WITHOUT ROWID;

-- The last seven days of reports as received, after validation, for
-- looking into anything odd in the counts. No address is stored.
CREATE TABLE log (
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX log_ts ON log (ts);
