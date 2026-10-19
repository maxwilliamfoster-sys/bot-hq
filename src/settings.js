// User settings, stored one JSON value per key in the settings table.
export const DEFAULT_SETTINGS = {
  quiet_start: "22:30",
  quiet_end: "07:00",
  notify_action: true,
  notify_warn: true,
  notify_good: true,
  notify_posted: true,
  notify_summary: true,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of results) {
    if (key in DEFAULT_SETTINGS) {
      try { out[key] = JSON.parse(value); } catch { /* keep default */ }
    }
  }
  return out;
}

// Only known keys with the right type are stored.
export async function putSettings(db, partial) {
  for (const [key, value] of Object.entries(partial || {})) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[key];
    if (typeof value !== typeof def) continue;
    if (typeof def === "string" && !HHMM.test(value)) continue;
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, JSON.stringify(value)).run();
  }
  return getSettings(db);
}

// Internal key/value state (not user settings), e.g. "summary_sent".
export async function getState(db, key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").bind(`_${key}`).first("value");
}

export async function setState(db, key, value) {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(`_${key}`, String(value)).run();
}
