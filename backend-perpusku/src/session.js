import { nanoid } from 'nanoid';
import db from './db.js';

// 🟢 Berapa lama user boleh diam sebelum otomatis logout (dalam menit)
const configuredMinutes = parseFloat(process.env.SESSION_TIMEOUT_MINUTES);
const timeoutMinutes = configuredMinutes > 0 ? configuredMinutes : 15;
export const SESSION_TIMEOUT_MS = timeoutMinutes * 60 * 1000;

const stmt = {
    insert: db.prepare('INSERT INTO sessions (token, email, role, lastActivity) VALUES (?, ?, ?, ?)'),
    find: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    touch: db.prepare('UPDATE sessions SET lastActivity = ? WHERE token = ?'),
    deleteByToken: db.prepare('DELETE FROM sessions WHERE token = ?'),
    deleteByEmail: db.prepare('DELETE FROM sessions WHERE email = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE lastActivity < ?'),
};

// 🟢 Bikin sesi baru waktu user berhasil login (1 user = 1 sesi aktif, sesi lama dihapus)
export const createSession = (email, role) => {
    stmt.deleteByEmail.run(email);
    const token = nanoid(32);
    stmt.insert.run(token, email, role, Date.now());
    return token;
};

// 🟢 Cek apakah token masih valid & belum idle kelamaan.
// Kalau masih valid, "lastActivity"-nya di-refresh (sliding expiration) supaya
// user yang aktif tidak ke-logout meski sudah lewat waktu awal.
// Return: { valid: true, email, role } atau { valid: false, reason }
export const touchSession = (token) => {
    if (!token) return { valid: false, reason: 'Token tidak ada.' };

    const session = stmt.find.get(token);
    if (!session) return { valid: false, reason: 'Sesi tidak ditemukan, silakan login lagi.' };

    const idleFor = Date.now() - session.lastActivity;
    if (idleFor > SESSION_TIMEOUT_MS) {
        stmt.deleteByToken.run(token);
        return { valid: false, reason: 'Sesi berakhir karena tidak ada aktivitas, silakan login lagi.' };
    }

    stmt.touch.run(Date.now(), token);
    return { valid: true, email: session.email, role: session.role };
};

export const destroySession = (token) => {
    stmt.deleteByToken.run(token);
};

// 🟢 Beres-beres sesi basi tiap beberapa menit, biar tabel sessions tidak menumpuk
export const startSessionCleanup = () => {
    setInterval(() => {
        stmt.deleteExpired.run(Date.now() - SESSION_TIMEOUT_MS);
    }, 5 * 60 * 1000);
};
