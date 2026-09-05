// 🟢 SATU SUMBER KEBENARAN untuk alamat backend.
// Sebelumnya URL backend ('127.0.0.1:5000', 'localhost:5000', proxy '/api' ke port 9000)
// tersebar dan tidak konsisten di banyak file — sekarang semua lewat sini.
export const API_BASE = 'http://127.0.0.1:5000';

// 🟢 Fetch helper terpusat:
// - Otomatis nempelin header 'x-session-token' kalau ada sessionToken.
// - Otomatis panggil onSessionExpired kalau backend bilang sesi sudah habis
//   (idle timeout ATAU sesi dihapus di server), supaya auto-logout konsisten
//   di semua tempat yang butuh login (upload buku, kirim review, dst).
export async function apiFetch(path, options = {}, sessionToken = null, onSessionExpired = null) {
    const isFormData = options.body instanceof FormData;

    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {}),
            ...(sessionToken ? { 'x-session-token': sessionToken } : {})
        }
    });

    if (response.status === 401) {
        const cloned = response.clone();
        try {
            const data = await cloned.json();
            if (data.code === 'SESSION_EXPIRED' && onSessionExpired) {
                onSessionExpired(data.message);
            }
        } catch {
            // respons 401 tanpa body JSON, abaikan
        }
    }

    return response;
}

// Shortcut kecil biar pemanggilan JSON POST/PUT lebih ringkas
export function apiFetchJson(path, body, method = 'POST', sessionToken = null, onSessionExpired = null) {
    return apiFetch(path, { method, body: JSON.stringify(body) }, sessionToken, onSessionExpired);
}

// =============================================================================
// 🔵 UPGRADE: helper untuk endpoint entitlement/access & wallet (points economy).
// Semua fungsi di bawah menerima `apiFetch` yang SUDAH terikat ke sessionToken user
// (lihat `authedFetch` di App.jsx), jadi tinggal dipanggil: `getWallet(apiFetch)`.
// =============================================================================

// --- Wallet (poin) ---
export const getWallet = (apiFetch) => apiFetch('/api/wallet').then(r => r.json());
export const getWalletTransactions = (apiFetch) => apiFetch('/api/wallet/transactions').then(r => r.json());
export const topUpWallet = (apiFetch, amount) =>
    apiFetch('/api/wallet/topup', { method: 'POST', body: JSON.stringify({ amount }) }).then(r => r.json());

// --- My Library ---
export const getMyLibrary = (apiFetch) => apiFetch('/api/my-library').then(r => r.json());
export const getBorrowedBooks = (apiFetch) => apiFetch('/api/my-library/borrowed').then(r => r.json());
export const getPurchasedBooks = (apiFetch) => apiFetch('/api/my-library/purchased').then(r => r.json());

// --- Book detail (opsi akses + status akses user saat ini) ---
export const getBookDetail = (apiFetch, bookId) => apiFetch(`/api/books/${bookId}`).then(r => r.json());

// --- Entitlement acquisition (borrow / unlock / purchase) ---
// action: 'borrow' | 'unlock' | 'purchase'
export const acquireAccess = (apiFetch, bookId, action) =>
    apiFetch(`/api/books/${bookId}/${action}`, { method: 'POST' }).then(async (res) => ({ ok: res.ok, status: res.status, ...(await res.json()) }));

// --- Protected content: preview / read / download ---
// Backend TIDAK PERNAH mengembalikan pdfUrl mentah. Selalu berupa token/URL
// sementara (5 menit) lewat /api/files/stream/{token} — lihat fileAccess.js di backend.
export const getPreviewUrl = async (apiFetch, bookId) => {
    const res = await apiFetch(`/api/books/${bookId}/preview`);
    const data = await res.json();
    return { ok: res.ok, status: res.status, ...data };
};

export const getReadUrl = async (apiFetch, bookId) => {
    const res = await apiFetch(`/api/books/${bookId}/read`);
    const data = await res.json();
    return { ok: res.ok, status: res.status, ...data };
};

export const getDownloadUrl = async (apiFetch, bookId) => {
    const res = await apiFetch(`/api/books/${bookId}/download`);
    const data = await res.json();
    return { ok: res.ok, status: res.status, ...data };
};

// --- Reading progress ---
export const saveReadingProgress = (apiFetch, bookId, location, progressPercentage) =>
    apiFetch(`/api/books/${bookId}/progress`, { method: 'PUT', body: JSON.stringify({ location, progressPercentage }) }).then(r => r.json());

// --- Admin: access policy management ---
export const getAccessPolicies = (apiFetch, bookId) => apiFetch(`/api/admin/books/${bookId}/access-policies`).then(r => r.json());
export const setAccessPolicies = (apiFetch, bookId, policies) =>
    apiFetch(`/api/admin/books/${bookId}/access-policies`, { method: 'PUT', body: JSON.stringify(policies) }).then(r => r.json());
export const getAllTransactions = (apiFetch) => apiFetch('/api/admin/transactions').then(r => r.json());
