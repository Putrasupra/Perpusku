// 🔵 ACCESS / ENTITLEMENT ENGINE
// ---------------------------------------------------------------------------
// Implements the design principle from the project spec:
//
//     DO NOT determine access only from book.is_premium.
//     Instead use:  User -> Entitlement -> Book -> Access Policy
//
// This module is the ONLY place that decides "is this user allowed to
// PREVIEW / READ / DOWNLOAD this book right now". Every route that serves
// book content must go through canAccess() instead of checking book fields
// directly.
// ---------------------------------------------------------------------------

import db from './db.js';

export const ACCESS_TYPES = ['PREVIEW', 'FREE_FULL', 'BORROW', 'UNLOCK_READ', 'PURCHASE'];

const now = () => new Date().toISOString();

const stmt = {
    getPolicies: db.prepare('SELECT * FROM access_policies WHERE bookId = ?'),
    getPolicy: db.prepare('SELECT * FROM access_policies WHERE bookId = ? AND accessType = ?'),
    upsertPolicy: db.prepare(`
        INSERT INTO access_policies (bookId, accessType, enabled, pricePoints, durationDays, allowDownload, previewPages, createdAt, updatedAt)
        VALUES (@bookId, @accessType, @enabled, @pricePoints, @durationDays, @allowDownload, @previewPages, @now, @now)
        ON CONFLICT(bookId, accessType) DO UPDATE SET
            enabled = excluded.enabled,
            pricePoints = excluded.pricePoints,
            durationDays = excluded.durationDays,
            allowDownload = excluded.allowDownload,
            previewPages = excluded.previewPages,
            updatedAt = excluded.updatedAt
    `),

    getWallet: db.prepare('SELECT * FROM wallets WHERE email = ?'),
    createWallet: db.prepare('INSERT INTO wallets (email, balance, updatedAt) VALUES (?, 0, ?)'),
    setBalance: db.prepare('UPDATE wallets SET balance = ?, updatedAt = ? WHERE email = ?'),
    insertTx: db.prepare(`INSERT INTO wallet_transactions (email, type, amount, balanceAfter, bookId, description, createdAt)
                           VALUES (@email, @type, @amount, @balanceAfter, @bookId, @description, @now)`),
    getTxByUser: db.prepare('SELECT * FROM wallet_transactions WHERE email = ? ORDER BY id DESC'),
    getAllTx: db.prepare('SELECT * FROM wallet_transactions ORDER BY id DESC'),

    findActiveEntitlement: db.prepare(`
        SELECT * FROM entitlements
        WHERE email = ? AND bookId = ? AND status = 'active'
        ORDER BY id DESC
    `),
    insertEntitlement: db.prepare(`
        INSERT INTO entitlements (email, bookId, type, canRead, canDownload, status, grantedAt, expiresAt)
        VALUES (@email, @bookId, @type, @canRead, @canDownload, 'active', @now, @expiresAt)
    `),
    expireEntitlement: db.prepare(`UPDATE entitlements SET status = 'expired' WHERE id = ?`),
    expireAllDue: db.prepare(`
        UPDATE entitlements SET status = 'expired'
        WHERE status = 'active' AND expiresAt IS NOT NULL AND expiresAt <= ?
    `),
    getLibrary: db.prepare(`
        SELECT e.*, b.title, b.author, b.coverUrl, b.category
        FROM entitlements e JOIN books b ON b.id = e.bookId
        WHERE e.email = ? AND e.status = 'active'
        ORDER BY e.id DESC
    `),

    insertAccessLog: db.prepare(`INSERT INTO access_logs (email, bookId, action, createdAt) VALUES (?, ?, ?, ?)`),
};

// ---------------------------------------------------------------------------
// Access policy helpers
// ---------------------------------------------------------------------------

const DEFAULT_LEGACY_POLICIES = [
    // 🟢 Backward-compat: buku lama (dibuat sebelum upgrade ini) tidak punya
    // access_policies sama sekali. Supaya tidak mendadak terkunci, buku tanpa
    // policy sama sekali dianggap FREE_FULL (perilaku lama: bebas dibaca),
    // tapi TIDAK otomatis boleh didownload.
    { accessType: 'PREVIEW', enabled: 1, pricePoints: 0, durationDays: null, allowDownload: 0, previewPages: 20 },
    { accessType: 'FREE_FULL', enabled: 1, pricePoints: 0, durationDays: null, allowDownload: 0, previewPages: null },
];

export const getBookPolicies = (bookId) => {
    let rows = stmt.getPolicies.all(bookId);
    if (rows.length === 0) {
        // Lazy-create default legacy policy so old data keeps working.
        for (const p of DEFAULT_LEGACY_POLICIES) {
            stmt.upsertPolicy.run({ bookId, now: now(), ...p });
        }
        rows = stmt.getPolicies.all(bookId);
    }
    return rows;
};

export const getPolicy = (bookId, accessType) => {
    const rows = getBookPolicies(bookId);
    return rows.find((r) => r.accessType === accessType) || null;
};

export const setBookPolicies = (bookId, policies) => {
    // policies: array of { accessType, enabled, pricePoints, durationDays, allowDownload, previewPages }
    const ts = now();
    for (const p of policies) {
        if (!ACCESS_TYPES.includes(p.accessType)) continue;
        stmt.upsertPolicy.run({
            bookId,
            accessType: p.accessType,
            enabled: p.enabled ? 1 : 0,
            pricePoints: Number(p.pricePoints) || 0,
            durationDays: p.durationDays != null ? Number(p.durationDays) : null,
            allowDownload: p.allowDownload ? 1 : 0,
            previewPages: p.previewPages != null ? Number(p.previewPages) : null,
            now: ts,
        });
    }
    return getBookPolicies(bookId);
};

// ---------------------------------------------------------------------------
// Wallet helpers
// ---------------------------------------------------------------------------

export const getOrCreateWallet = (email) => {
    let wallet = stmt.getWallet.get(email);
    if (!wallet) {
        stmt.createWallet.run(email, now());
        wallet = stmt.getWallet.get(email);
    }
    return wallet;
};

export const getBalance = (email) => getOrCreateWallet(email).balance;

// Adjust wallet balance and ALWAYS write a transaction record (auditability).
// amount: positive = credit (topup/refund), negative = debit (spend).
export const applyWalletTransaction = ({ email, type, amount, bookId = null, description = '' }) => {
    const wallet = getOrCreateWallet(email);
    const newBalance = wallet.balance + amount;
    if (newBalance < 0) {
        throw new Error('INSUFFICIENT_BALANCE');
    }
    stmt.setBalance.run(newBalance, now(), email);
    stmt.insertTx.run({ email, type, amount, balanceAfter: newBalance, bookId, description, now: now() });
    return newBalance;
};

export const getWalletTransactions = (email) => stmt.getTxByUser.all(email);
export const getAllWalletTransactions = () => stmt.getAllTx.all();

// ---------------------------------------------------------------------------
// Entitlement helpers
// ---------------------------------------------------------------------------

// Dynamically expire due entitlements. Called on every access check, so it
// self-heals even without the background sweep job running.
export const sweepExpiredEntitlements = () => {
    stmt.expireAllDue.run(now());
};

export const findValidEntitlement = (email, bookId) => {
    if (!email) return null;
    sweepExpiredEntitlements();
    const candidates = stmt.findActiveEntitlement.all(email, bookId);
    // Double safety: even if sweep hasn't run, ignore anything past expiry.
    const nowTs = now();
    return candidates.find((e) => !e.expiresAt || e.expiresAt > nowTs) || null;
};

export const grantEntitlement = ({ email, bookId, type, canRead = 1, canDownload = 0, expiresAt = null }) => {
    stmt.insertEntitlement.run({ email, bookId, type, canRead: canRead ? 1 : 0, canDownload: canDownload ? 1 : 0, expiresAt, now: now() });
    return findValidEntitlement(email, bookId);
};

export const getMyLibrary = (email) => stmt.getLibrary.all(email);

export const logAccess = (email, bookId, action) => {
    stmt.insertAccessLog.run(email || null, bookId, action, now());
};

// ---------------------------------------------------------------------------
// canAccess() — the single source of truth for content access decisions.
// Mirrors the pseudocode from the technical architecture doc:
//
//   function canAccess(user, book, action):
//       if action == PREVIEW: return preview exists
//       if book is FREE_FULL: return true
//       entitlement = findValidEntitlement(user, book)
//       if action == READ: return entitlement allows READ
//       if action == DOWNLOAD: return entitlement allows DOWNLOAD
//       return false
// ---------------------------------------------------------------------------

export const canAccess = (email, bookId, action) => {
    const policies = getBookPolicies(bookId);
    const byType = Object.fromEntries(policies.map((p) => [p.accessType, p]));

    if (action === 'PREVIEW') {
        const p = byType.PREVIEW;
        return { allowed: !!(p && p.enabled), previewPages: p?.previewPages ?? null };
    }

    if (byType.FREE_FULL?.enabled) {
        if (action === 'READ') return { allowed: true, source: 'FREE_FULL' };
        if (action === 'DOWNLOAD') return { allowed: !!byType.FREE_FULL.allowDownload, source: 'FREE_FULL' };
    }

    const entitlement = findValidEntitlement(email, bookId);
    if (!entitlement) return { allowed: false, reason: 'NO_ENTITLEMENT' };

    if (action === 'READ') return { allowed: !!entitlement.canRead, source: entitlement.type, entitlement };
    if (action === 'DOWNLOAD') return { allowed: !!entitlement.canDownload, source: entitlement.type, entitlement };

    return { allowed: false, reason: 'UNKNOWN_ACTION' };
};
