// 🔵 PROTECTED FILE ACCESS
// ---------------------------------------------------------------------------
// Technical architecture doc says: "Never expose a permanent public URL to
// premium book files. Backend generates a short-lived signed URL OR
// streams/proxies the file."
//
// This project doesn't (yet) use real object storage (S3/GCS/R2), so this
// module simulates the "signed URL" pattern on top of local disk: once a
// route in server.js confirms canAccess() == true, it calls issueToken() to
// get a random one-time token that resolves to the real file for a few
// minutes only. The actual file path is NEVER sent to the frontend.
// ---------------------------------------------------------------------------

import { nanoid } from 'nanoid';
import path from 'path';
import db from './db.js';

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes is enough to open a reader / start a download

const stmt = {
    insert: db.prepare('INSERT INTO file_access_tokens (token, filePath, fileName, disposition, expiresAt) VALUES (?, ?, ?, ?, ?)'),
    find: db.prepare('SELECT * FROM file_access_tokens WHERE token = ?'),
    deleteExpired: db.prepare('DELETE FROM file_access_tokens WHERE expiresAt < ?'),
};

export const issueToken = (filePath, disposition = 'inline') => {
    const token = nanoid(40);
    stmt.insert.run(token, filePath, path.basename(filePath), disposition, Date.now() + TOKEN_TTL_MS);
    return { token, expiresInSeconds: TOKEN_TTL_MS / 1000 };
};

export const resolveToken = (token) => {
    const row = stmt.find.get(token);
    if (!row) return null;
    if (row.expiresAt < Date.now()) return null;
    return row;
};

// 🟢 Housekeeping tiap 5 menit, sama pola-nya dengan startSessionCleanup di session.js
export const startFileTokenCleanup = () => {
    setInterval(() => {
        stmt.deleteExpired.run(Date.now());
    }, 5 * 60 * 1000);
};
