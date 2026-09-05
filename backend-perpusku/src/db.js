import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 🟢 Lokasi file database SQLite (satu file fisik, gampang di-backup)
const DB_PATH = path.join(__dirname, '..', 'database.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // Lebih aman & cepat untuk banyak request bersamaan

// 🌟 AUTO-CREATE TABEL (kalau belum ada, sekali jalan aman diulang-ulang)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
  );

  CREATE TABLE IF NOT EXISTS otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    otp TEXT NOT NULL,
    name TEXT,
    password TEXT,
    type TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    rating INTEGER DEFAULT 5,
    category TEXT DEFAULT 'Umum',
    description TEXT,
    coverUrl TEXT,
    pdfUrl TEXT
  );

  CREATE TABLE IF NOT EXISTS feedbacks (
    id INTEGER PRIMARY KEY,
    name TEXT,
    email TEXT,
    message TEXT,
    date TEXT
  );

  -- 🟢 Sesi login. lastActivity dipakai untuk auto-logout kalau user diam terlalu lama.
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    lastActivity INTEGER NOT NULL
  );

  -- 🟢 Review/ulasan. bookId NULL = review umum di halaman Community,
  -- bookId terisi = review buku spesifik yang muncul di BookDetail.
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookId INTEGER,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    rating INTEGER,
    message TEXT NOT NULL,
    date TEXT NOT NULL
  );

  -- 🟢 Artikel Blog. Hanya admin yang boleh membuat/mengedit/menghapus (dicek di server.js).
  CREATE TABLE IF NOT EXISTS blogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    content TEXT NOT NULL,
    imgUrl TEXT,
    authorEmail TEXT,
    date TEXT NOT NULL
  );

  -- 🟢 Favorit buku, per user (identifikasi via email). Sebelumnya cuma di React state
  -- (hilang tiap refresh) — sekarang persist di database.
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    bookId INTEGER NOT NULL,
    date TEXT NOT NULL,
    UNIQUE(email, bookId)
  );

  -- 🟢 Batasi 1 review per user per buku. Pakai PARTIAL unique index (WHERE bookId IS NOT NULL)
  -- supaya review umum (bookId kosong, kalau ada) tidak ikut kena batasan ini.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_one_per_user_per_book
    ON reviews(email, bookId) WHERE bookId IS NOT NULL;

  -- =========================================================================
  -- 🔵 ENTITLEMENT / ACCESS MODEL (upgrade)
  -- Prinsip desain: JANGAN tentukan akses cuma dari 1 flag "is_premium" di
  -- tabel books. Sebagai gantinya: User -> Entitlement -> Book -> Access Policy.
  -- Setiap buku bisa punya beberapa opsi akses sekaligus (preview gratis,
  -- borrow 7 hari, unlock baca, purchase permanen), masing-masing dengan
  -- harga & aturannya sendiri di access_policies.
  -- =========================================================================

  -- 🔵 Kebijakan akses per buku per tipe akses.
  -- accessType: PREVIEW | FREE_FULL | BORROW | UNLOCK_READ | PURCHASE
  CREATE TABLE IF NOT EXISTS access_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bookId INTEGER NOT NULL,
    accessType TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    pricePoints INTEGER NOT NULL DEFAULT 0,
    durationDays INTEGER,              -- hanya dipakai oleh BORROW
    allowDownload INTEGER NOT NULL DEFAULT 0, -- kalau 1, akses ini juga membuka izin DOWNLOAD
    previewPages INTEGER,              -- hanya dipakai oleh PREVIEW
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(bookId, accessType)
  );

  -- 🔵 Wallet poin milik tiap member. 1 baris per email, dibuat otomatis
  -- (lazy) saat pertama kali dibutuhkan.
  CREATE TABLE IF NOT EXISTS wallets (
    email TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL
  );

  -- 🔵 Setiap perubahan saldo WAJIB tercatat di sini (auditability requirement).
  -- type: TOPUP | BORROW | UNLOCK_READ | PURCHASE | REFUND
  -- amount: positif untuk penambahan (topup/refund), negatif untuk pengeluaran.
  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balanceAfter INTEGER NOT NULL,
    bookId INTEGER,
    description TEXT,
    createdAt TEXT NOT NULL
  );

  -- 🔵 Bukti kepemilikan akses (entitlement). Inilah sumber kebenaran untuk
  -- "apakah user ini boleh baca/download buku ini", BUKAN books.is_premium.
  -- type: BORROW | UNLOCK_READ | PURCHASE | FREE_FULL
  -- status: active | expired | revoked
  CREATE TABLE IF NOT EXISTS entitlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    bookId INTEGER NOT NULL,
    type TEXT NOT NULL,
    canRead INTEGER NOT NULL DEFAULT 1,
    canDownload INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    grantedAt TEXT NOT NULL,
    expiresAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_entitlements_lookup ON entitlements(email, bookId, status);

  -- 🔵 Log setiap kali konten dibuka/diunduh — dipakai untuk audit trail
  -- (bukan untuk business logic access-check, cuma catatan histori).
  -- action: PREVIEW | READ | DOWNLOAD
  CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    bookId INTEGER NOT NULL,
    action TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  -- 🔵 Token akses file sementara (signed-URL pengganti). Backend tidak pernah
  -- mengekspos path file asli ke frontend; sebagai gantinya, frontend
  -- memanggil /api/books/{id}/read atau /download, backend memvalidasi
  -- entitlement lalu membuatkan token acak yang hanya valid beberapa menit
  -- dan hanya untuk 1 file spesifik.
  CREATE TABLE IF NOT EXISTS file_access_tokens (
    token TEXT PRIMARY KEY,
    filePath TEXT NOT NULL,
    fileName TEXT NOT NULL,
    disposition TEXT NOT NULL, -- inline (baca) | attachment (download)
    expiresAt INTEGER NOT NULL
  );

  -- 🔵 Progres membaca per user per buku (dipakai reader online).
  CREATE TABLE IF NOT EXISTS reading_progress (
    email TEXT NOT NULL,
    bookId INTEGER NOT NULL,
    location TEXT,
    progressPercentage REAL DEFAULT 0,
    lastReadAt TEXT NOT NULL,
    PRIMARY KEY (email, bookId)
  );
`);

export default db;
