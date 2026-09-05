import 'dotenv/config'; // 🟢 HARUS jadi import PALING ATAS: modul lain (session.js) baca process.env saat di-import

import Hapi from '@hapi/hapi';
import nodemailer from 'nodemailer';
import fs from 'fs-extra';
import inert from '@hapi/inert';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

import db from './db.js'; // 🟢 SQLite, gantinya database.json
import { createSession, touchSession, destroySession, startSessionCleanup, SESSION_TIMEOUT_MS } from './session.js';
import {
    getBookPolicies,
    getPolicy,
    setBookPolicies,
    canAccess,
    findValidEntitlement,
    grantEntitlement,
    getMyLibrary,
    logAccess,
    getOrCreateWallet,
    applyWalletTransaction,
    getWalletTransactions,
    getAllWalletTransactions,
    sweepExpiredEntitlements,
} from './access.js'; // 🔵 UPGRADE: entitlement/access engine (User -> Entitlement -> Book -> Access Policy)
import { issueToken, resolveToken, startFileTokenCleanup } from './fileAccess.js'; // 🔵 UPGRADE: signed/short-lived file access
import { seedTestUsers } from './seed-test-users.js'; // 🟡 DEV: akun sampel admin/member lewat .env, lihat SEED_TEST_USERS

const SALT_ROUNDS = 10;

// 🟢 GANTI PROVIDER AI: sebelumnya Google Gemini (@google/generative-ai), key-nya sudah
// tidak berfungsi. Sekarang pakai Groq — endpoint-nya kompatibel format OpenAI, jadi
// tidak perlu SDK tambahan, cukup fetch biasa. Daftar key gratis di https://console.groq.com/keys
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 🟢 KONFIGURASI UTAMA
const PORT = process.env.PORT_SERVER || 5000;
const HOST = '127.0.0.1';
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// 🌟 AUTO-CREATE FOLDER UPLOAD (tabel sudah dibuat otomatis oleh db.js)
fs.ensureDirSync(UPLOAD_DIR);

// 🟢 SETUP EMAIL (NODEMAILER DARI BRANKAS)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_PENGIRIM,
        pass: process.env.KUNCI_EMAIL
    }
});

// --- PREPARED STATEMENTS (dibuat sekali, dipakai berulang -> cepat & aman dari SQL injection) ---
const stmt = {
    findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)'),
    updateUserPassword: db.prepare('UPDATE users SET password = ? WHERE email = ?'),

    findOtp: db.prepare('SELECT * FROM otps WHERE email = ? AND otp = ?'),
    findOtpByEmailType: db.prepare('SELECT * FROM otps WHERE email = ? AND type = ? ORDER BY id DESC LIMIT 1'),
    deleteOtpByEmail: db.prepare('DELETE FROM otps WHERE email = ?'),
    insertOtp: db.prepare('INSERT INTO otps (email, otp, name, password, type, expires) VALUES (?, ?, ?, ?, ?, ?)'),

    getAllBooks: db.prepare('SELECT * FROM books ORDER BY id DESC'),
    getBookById: db.prepare('SELECT * FROM books WHERE id = ?'),
    insertBook: db.prepare(`INSERT INTO books (id, title, author, rating, category, description, coverUrl, pdfUrl)
                            VALUES (@id, @title, @author, @rating, @category, @description, @coverUrl, @pdfUrl)`),

    insertFeedback: db.prepare('INSERT INTO feedbacks (id, name, email, message, date) VALUES (?, ?, ?, ?, ?)'),

    // 🟢 Review (Community & Book Detail)
    getReviewsByBook: db.prepare('SELECT * FROM reviews WHERE bookId = ? ORDER BY id DESC'),
    getGeneralReviews: db.prepare('SELECT * FROM reviews WHERE bookId IS NULL ORDER BY id DESC'),
    getAllReviews: db.prepare('SELECT * FROM reviews ORDER BY id DESC'),
    findReviewByUserAndBook: db.prepare('SELECT * FROM reviews WHERE email = ? AND bookId = ?'),
    insertReview: db.prepare('INSERT INTO reviews (bookId, name, email, rating, message, date) VALUES (?, ?, ?, ?, ?, ?)'),

    // 🟢 Blog (khusus admin untuk tulis/edit/hapus)
    getAllBlogs: db.prepare('SELECT * FROM blogs ORDER BY id DESC'),
    getBlogById: db.prepare('SELECT * FROM blogs WHERE id = ?'),
    insertBlog: db.prepare('INSERT INTO blogs (title, excerpt, content, imgUrl, authorEmail, date) VALUES (?, ?, ?, ?, ?, ?)'),
    updateBlog: db.prepare('UPDATE blogs SET title = ?, excerpt = ?, content = ?, imgUrl = ? WHERE id = ?'),
    deleteBlog: db.prepare('DELETE FROM blogs WHERE id = ?'),

    // 🟢 Favorit
    getFavoritesByUser: db.prepare('SELECT bookId FROM favorites WHERE email = ?'),
    findFavorite: db.prepare('SELECT * FROM favorites WHERE email = ? AND bookId = ?'),
    insertFavorite: db.prepare('INSERT INTO favorites (email, bookId, date) VALUES (?, ?, ?)'),
    deleteFavorite: db.prepare('DELETE FROM favorites WHERE email = ? AND bookId = ?'),
};

// 🟢 MIDDLEWARE: Wajib bawa session token yang valid & belum idle kelamaan.
// Dipasang di route yang perlu login (contoh: upload buku).
// Frontend wajib kirim header: x-session-token: <token dari /api/login>
const requireSession = (request, h) => {
    const token = request.headers['x-session-token'];
    const result = touchSession(token);

    if (!result.valid) {
        return h.response({ status: 'error', message: result.reason, code: 'SESSION_EXPIRED' }).code(401).takeover();
    }

    request.auth = { email: result.email, role: result.role };
    return h.continue;
};

// 🟢 Sama seperti requireSession, tapi TIDAK menolak request tanpa token.
// Dipakai di route yang boleh diakses publik tapi perilakunya beda kalau
// user login (contoh: cek status akses buku sebelum login vs sesudah login).
const optionalSession = (request, h) => {
    const token = request.headers['x-session-token'];
    if (token) {
        const result = touchSession(token);
        if (result.valid) request.auth = { email: result.email, role: result.role };
    }
    return h.continue;
};

// 🔵 UPGRADE: buku TIDAK PERNAH dikirim ke client dengan pdfUrl mentah/lokasi
// file asli — itu justru yang dilarang di dokumen arsitektur ("Never expose a
// permanent public URL to premium book files"). Sebagai gantinya, client
// dapat cover (aman untuk publik) + ringkasan opsi akses (accessOptions),
// dan HARUS memanggil /read atau /download untuk dapat token file sementara.
const sanitizeBook = (book, email = null) => {
    const { pdfUrl, ...safe } = book;
    const policies = getBookPolicies(book.id);
    const accessOptions = policies
        .filter((p) => p.enabled)
        .map((p) => ({
            accessType: p.accessType,
            pricePoints: p.pricePoints,
            durationDays: p.durationDays,
            allowDownload: !!p.allowDownload,
            previewPages: p.previewPages,
        }));

    let myAccess = { canRead: false, canDownload: false, source: null };
    const freePolicy = policies.find((p) => p.accessType === 'FREE_FULL' && p.enabled);
    if (freePolicy) {
        myAccess = { canRead: true, canDownload: !!freePolicy.allowDownload, source: 'FREE_FULL' };
    } else if (email) {
        const entitlement = findValidEntitlement(email, book.id);
        if (entitlement) {
            myAccess = {
                canRead: !!entitlement.canRead,
                canDownload: !!entitlement.canDownload,
                source: entitlement.type,
                expiresAt: entitlement.expiresAt,
            };
        }
    }

    return { ...safe, hasFile: !!pdfUrl, accessOptions, myAccess };
};

// 🔵 UPGRADE: buku lama (sebelum upgrade ini) masih menyimpan pdfUrl sebagai
// URL publik penuh (http://127.0.0.1:5000/uploads/book_xxx.pdf), buku baru
// hanya menyimpan nama file. Fungsi ini menormalkan keduanya jadi 1 path
// fisik di disk, dipakai HANYA di sisi server (tidak pernah dikirim ke client).
const resolveBookFilePath = (book) => {
    if (!book.pdfUrl) return null;
    const fileName = book.pdfUrl.includes('/') ? book.pdfUrl.split('/').pop() : book.pdfUrl;
    return path.join(UPLOAD_DIR, fileName);
};

// 🔵 UPGRADE: satu handler dipakai untuk borrow/unlock/purchase karena
// alurnya identik (lihat 04_activity_borrow_book.puml) — cuma beda accessType,
// harga, dan durasi. Urutan langkahnya sengaja mengikuti activity diagram:
//   load policy -> cek entitlement aktif yang sudah ada -> cek saldo poin ->
//   potong poin -> catat transaksi -> buat entitlement -> masuk My Library.
const handleAcquireAccess = async (request, h, type) => {
    const bookId = Number(request.params.id);
    const book = stmt.getBookById.get(bookId);
    if (!book) return h.response({ status: 'error', message: 'Buku tidak ditemukan.' }).code(404);

    const policy = getPolicy(bookId, type);
    if (!policy || !policy.enabled) {
        return h.response({ status: 'error', message: `Opsi ${type} tidak tersedia untuk buku ini.` }).code(400);
    }

    // Sudah punya akses baca yang masih berlaku? Jangan potong poin dua kali.
    const existing = findValidEntitlement(request.auth.email, bookId);
    if (existing) {
        return h.response({ status: 'success', message: 'Kamu sudah punya akses ke buku ini.', data: existing }).code(200);
    }

    const wallet = getOrCreateWallet(request.auth.email);
    if (wallet.balance < policy.pricePoints) {
        return h.response({ status: 'error', message: 'Poin kamu tidak cukup. Silakan top-up dulu.', code: 'INSUFFICIENT_BALANCE' }).code(402);
    }

    let balanceAfter;
    try {
        balanceAfter = applyWalletTransaction({
            email: request.auth.email,
            type,
            amount: -policy.pricePoints,
            bookId,
            description: `${type} buku "${book.title}"`
        });
    } catch (err) {
        return h.response({ status: 'error', message: 'Poin kamu tidak cukup.', code: 'INSUFFICIENT_BALANCE' }).code(402);
    }

    const expiresAt = (type === 'BORROW' && policy.durationDays)
        ? new Date(Date.now() + policy.durationDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

    const entitlement = grantEntitlement({
        email: request.auth.email,
        bookId,
        type,
        canRead: 1,
        canDownload: policy.allowDownload ? 1 : 0,
        expiresAt
    });

    return h.response({
        status: 'success',
        message: type === 'BORROW' ? 'Berhasil meminjam buku!' : type === 'PURCHASE' ? 'Pembelian berhasil, buku sudah jadi milikmu!' : 'Akses baca premium berhasil dibuka!',
        data: { entitlement, balance: balanceAfter }
    }).code(201);
};

const init = async () => {
    const server = Hapi.server({
        port: PORT,
        host: HOST,
        routes: {
            cors: {
                origin: ['*'],
                // 🟢 FIX: 'x-session-token' wajib ada di sini. Tanpa ini, browser membatalkan
                // request preflight CORS untuk setiap panggilan yang butuh login (upload buku,
                // kirim review, blog, favorit, dst) — muncul sebagai "Gagal terhubung ke server
                // backend" di frontend, padahal backend-nya baik-baik saja (curl tidak kena efek
                // ini karena curl tidak menjalankan CORS preflight seperti browser).
                additionalHeaders: ['cache-control', 'x-requested-with', 'x-session-token']
            }
        }
    });

    await server.register(inert);

    // --- ROUTE: BACA FILE FISIK PUBLIK (COVER & GAMBAR BLOG SAJA) ---
    // 🔵 UPGRADE (security): sebelumnya route ini men-serve SEMUA isi folder
    // uploads/ tanpa terkecuali, termasuk file PDF buku premium — artinya
    // siapapun yang tahu/menebak nama filenya bisa baca buku berbayar tanpa
    // bayar sepeser pun. Sekarang folder publik ini HANYA untuk file yang
    // memang aman dilihat publik (cover buku, gambar blog). File buku
    // (`book_...`) sengaja diblokir di sini; satu-satunya jalan resminya
    // adalah lewat /api/books/{id}/read atau /download, yang mengecek
    // entitlement lebih dulu lalu memberi token sementara via
    // /api/files/stream/{token}.
    server.route({
        method: 'GET',
        path: '/uploads/{param*}',
        handler: (request, h) => {
            const requested = request.params.param || '';
            if (requested.startsWith('book_')) {
                return h.response({ status: 'error', message: 'File buku tidak bisa diakses langsung. Gunakan endpoint baca/download resmi.' }).code(403);
            }
            return h.file(path.join(UPLOAD_DIR, requested));
        }
    });

    // --- ROUTE: STREAM FILE VIA TOKEN SEMENTARA (signed-URL pengganti) ---
    // Token didapat dari /api/books/{id}/read atau /download, valid ~5 menit,
    // dan hanya menunjuk ke 1 file spesifik (lihat fileAccess.js).
    server.route({
        method: 'GET',
        path: '/api/files/stream/{token}',
        handler: (request, h) => {
            const record = resolveToken(request.params.token);
            if (!record) {
                return h.response({ status: 'error', message: 'Tautan akses sudah kedaluwarsa atau tidak valid. Silakan buka ulang bukunya.' }).code(410);
            }
            const response = h.file(record.filePath, { confine: false });
            if (record.disposition === 'attachment') {
                response.header('Content-Disposition', `attachment; filename="${record.fileName}"`);
            }
            return response;
        }
    });

    // --- ROUTE 1: REGISTER ---
    server.route({
        method: 'POST',
        path: '/api/register',
        handler: async (request, h) => {
            const { name, email, password } = request.payload;

            if (stmt.findUserByEmail.get(email)) {
                return h.response({ status: 'error', message: 'Email sudah terdaftar!' }).code(400);
            }

            // 🟢 Password langsung di-hash di sini, jadi plaintext-nya tidak pernah
            // disimpan ke disk sama sekali (bahkan tabel otps sementara pun sudah hash).
            const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

            const otp = Math.floor(1000 + Math.random() * 9000).toString();
            stmt.deleteOtpByEmail.run(email);
            stmt.insertOtp.run(email, otp, name, hashedPassword, 'register', Date.now() + 300000);

            try {
                await transporter.sendMail({
                    from: '"Perpusku Admin" <admin@perpusku.com>',
                    to: email, subject: '🔒 Verifikasi Akun Perpusku',
                    html: `<h3>Halo ${name},</h3><p>Kode OTP kamu adalah: <b style="font-size:20px;">${otp}</b></p>`
                });
                return { status: 'success', message: 'OTP terkirim ke email.' };
            } catch (err) {
                return h.response({ status: 'error', message: 'Gagal kirim email.' }).code(500);
            }
        }
    });

    // --- ROUTE 2: VERIFIKASI & SIMPAN USER (DENGAN JALUR VIP ADMIN) ---
    server.route({
        method: 'POST',
        path: '/api/verify-otp',
        handler: async (request, h) => {
            const { email, otp } = request.payload;
            const record = stmt.findOtp.get(email, otp);

            if (!record || Date.now() > record.expires) {
                return h.response({ status: 'error', message: 'OTP salah atau kadaluarsa.' }).code(400);
            }

            let assignedRole = 'member';
            if (email === process.env.ADMIN_EMAIL_UTAMA) assignedRole = 'admin';

            stmt.insertUser.run(record.name, email, record.password, assignedRole);
            stmt.deleteOtpByEmail.run(email);

            return { status: 'success', message: 'Akun berhasil dibuat!' };
        }
    });

    // --- ROUTE 3: LOGIN ---
    server.route({
        method: 'POST',
        path: '/api/login',
        handler: async (request, h) => {
            const { email, password } = request.payload;
            const user = stmt.findUserByEmail.get(email);
            if (!user) return h.response({ status: 'error', message: 'Email atau Password salah.' }).code(401);

            const match = await bcrypt.compare(password, user.password);
            if (!match) return h.response({ status: 'error', message: 'Email atau Password salah.' }).code(401);

            const sessionToken = createSession(user.email, user.role);
            const { password: _pw, ...safeUser } = user; // jangan pernah kirim hash password ke frontend

            return {
                status: 'success',
                user: safeUser,
                sessionToken,
                sessionTimeoutMinutes: SESSION_TIMEOUT_MS / 60000
            };
        }
    });

    // --- ROUTE 3b: LOGOUT ---
    server.route({
        method: 'POST',
        path: '/api/logout',
        handler: async (request, h) => {
            const token = request.headers['x-session-token'];
            if (token) destroySession(token);
            return { status: 'success', message: 'Berhasil logout.' };
        }
    });

    // --- ROUTE 3c: CEK SESI (dipanggil frontend tiap ada aktivitas / berkala,
    // sekaligus dipakai untuk auto-logout: kalau 401 berarti sesi sudah habis) ---
    server.route({
        method: 'GET',
        path: '/api/session/ping',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            return { status: 'success', email: request.auth.email, role: request.auth.role };
        }
    });

    // --- ROUTE 4: LUPA PASSWORD ---
    server.route({
        method: 'POST',
        path: '/api/forgot-password',
        handler: async (request, h) => {
            const { email } = request.payload;
            const user = stmt.findUserByEmail.get(email);
            if (!user) return h.response({ status: 'error', message: 'Email tidak ditemukan.' }).code(404);

            const otp = Math.floor(1000 + Math.random() * 9000).toString();
            stmt.deleteOtpByEmail.run(email);
            stmt.insertOtp.run(email, otp, null, null, 'reset', Date.now() + 300000);

            await transporter.sendMail({
                to: email, subject: '🔑 Reset Password Perpusku', html: `<p>Kode OTP reset kamu: <b>${otp}</b></p>`
            });
            return { status: 'success', message: 'OTP reset sudah dikirim.' };
        }
    });

    // --- ROUTE 5: RESET PASSWORD ---
    server.route({
        method: 'POST',
        path: '/api/reset-password',
        handler: async (request, h) => {
            const { email, otp, newPassword } = request.payload;
            const record = stmt.findOtp.get(email, otp);
            if (!record || record.type !== 'reset') {
                return h.response({ status: 'error', message: 'OTP tidak valid.' }).code(400);
            }

            const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
            stmt.updateUserPassword.run(hashedPassword, email);
            stmt.deleteOtpByEmail.run(email);

            return { status: 'success', message: 'Password berhasil diperbarui!' };
        }
    });

    // --- ROUTE 6: AMBIL DAFTAR BUKU (publik, tanpa pdfUrl mentah) ---
    server.route({
        method: 'GET',
        path: '/api/books',
        options: { pre: [{ method: optionalSession }] },
        handler: async (request, h) => {
            const books = stmt.getAllBooks.all();
            const email = request.auth?.email || null;
            return { status: 'success', data: books.map((b) => sanitizeBook(b, email)) };
        }
    });

    // --- ROUTE 6b: DETAIL 1 BUKU (opsi akses + status akses user saat ini) ---
    server.route({
        method: 'GET',
        path: '/api/books/{id}',
        options: { pre: [{ method: optionalSession }] },
        handler: async (request, h) => {
            const book = stmt.getBookById.get(Number(request.params.id));
            if (!book) return h.response({ status: 'error', message: 'Buku tidak ditemukan.' }).code(404);
            return { status: 'success', data: sanitizeBook(book, request.auth?.email || null) };
        }
    });

    // --- ROUTE 7: ADMIN TAMBAH BUKU (TERIMA FILE FISIK MULTIPART + KONFIGURASI AKSES) ---
    server.route({
        method: 'POST',
        path: '/api/books',
        options: {
            pre: [{ method: requireSession }],
            payload: {
                output: 'stream',
                parse: true,
                multipart: true,
                maxBytes: 50 * 1024 * 1024
            }
        },
        handler: async (request, h) => {
            if (request.auth.role !== 'admin') {
                return h.response({ status: 'error', message: 'Hanya admin yang boleh menambah buku.' }).code(403);
            }

            const data = request.payload;
            const bookId = Date.now();

            // 🔵 FIX (pre-existing bug): sebelumnya kedua file di-pipe tanpa
            // ditunggu selesainya ("fire-and-forget"), jadi response bisa
            // terkirim & baris DB ke-insert SEBELUM file selesai ditulis ke
            // disk — kadang menghasilkan file 0-byte. Sekarang keduanya
            // ditunggu (Promise), sama seperti pola yang sudah dipakai di
            // upload cover artikel blog.
            const writeUploadedFile = (file, filePath) => new Promise((resolve, reject) => {
                const stream = fs.createWriteStream(filePath);
                file.pipe(stream);
                stream.on('finish', resolve);
                stream.on('error', reject);
                file.on('error', reject);
            });

            const coverName = `cover_${bookId}_${data.coverFile.hapi.filename}`;
            const coverPath = path.join(UPLOAD_DIR, coverName);

            // 🔵 UPGRADE: file buku TIDAK disimpan sebagai URL publik lagi.
            // Cukup nama filenya saja — path fisik lengkap dihitung ulang saat
            // dibutuhkan (lihat resolveBookFilePath), dan tidak pernah dikirim ke client.
            const bookFileName = `book_${bookId}_${data.pdfFile.hapi.filename}`;
            const bookPath = path.join(UPLOAD_DIR, bookFileName);

            await Promise.all([
                writeUploadedFile(data.coverFile, coverPath),
                writeUploadedFile(data.pdfFile, bookPath),
            ]);

            const newBook = {
                id: bookId,
                title: data.title,
                author: data.author,
                rating: parseInt(data.rating) || 5,
                category: data.category || "Umum",
                description: data.description || "",
                coverUrl: `http://127.0.0.1:${PORT}/uploads/${coverName}`,
                pdfUrl: bookFileName
            };

            stmt.insertBook.run(newBook);

            // 🔵 UPGRADE: buat access_policies dari payload admin (kalau dikirim),
            // atau fallback ke default masuk akal (preview gratis + borrow/unlock/purchase berbayar).
            let accessConfig = null;
            try {
                accessConfig = data.accessConfig ? JSON.parse(data.accessConfig) : null;
            } catch {
                accessConfig = null;
            }
            setBookPolicies(bookId, accessConfig || [
                { accessType: 'PREVIEW', enabled: true, pricePoints: 0, previewPages: 20 },
                { accessType: 'FREE_FULL', enabled: false },
                { accessType: 'BORROW', enabled: true, pricePoints: 50, durationDays: 7, allowDownload: false },
                { accessType: 'UNLOCK_READ', enabled: true, pricePoints: 100, allowDownload: false },
                { accessType: 'PURCHASE', enabled: true, pricePoints: 200, allowDownload: true },
            ]);

            return h.response({ status: 'success', message: `Buku "${data.title}" fisik berhasil diunggah!`, data: { id: bookId } }).code(201);
        }
    });

    // --- ROUTE 8: KIRIM FEEDBACK (DARI HALAMAN ABOUT US) ---
    server.route({
        method: 'POST',
        path: '/api/feedback',
        handler: async (request, h) => {
            const { name, email, message } = request.payload;

            stmt.insertFeedback.run(Date.now(), name, email, message, new Date().toLocaleString());

            try {
                await transporter.sendMail({
                    from: '"Notifikasi Perpusku" <admin@perpusku.com>',
                    to: process.env.ADMIN_EMAIL_UTAMA,
                    subject: `📬 Feedback Baru dari ${name}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
                            <h3 style="color: #1f7a48;">Ada pesan baru dari aplikasi Perpusku!</h3>
                            <p><strong>Pengirim:</strong> ${name} (${email})</p>
                            <hr/>
                            <p><strong>Pesan:</strong></p>
                            <p style="background: #f9f9f9; padding: 15px; border-left: 4px solid #1f7a48;">
                                ${message}
                            </p>
                        </div>
                    `
                });
                return h.response({ status: 'success', message: 'Terima kasih! Pesanmu sudah terbang ke Developer.' }).code(200);
            } catch (error) {
                return h.response({ status: 'error', message: 'Gagal mengirim pesan.' }).code(500);
            }
        }
    });

    // --- ROUTE 10: AMBIL REVIEW (?bookId=123 untuk review buku tertentu, kosongkan untuk semua review/feed Community) ---
    server.route({
        method: 'GET',
        path: '/api/reviews',
        handler: async (request, h) => {
            const { bookId } = request.query;
            const reviews = bookId ? stmt.getReviewsByBook.all(Number(bookId)) : stmt.getAllReviews.all();
            return { status: 'success', data: reviews };
        }
    });

    // --- ROUTE 10b: KIRIM REVIEW (wajib login, supaya nama/email tidak bisa dipalsukan dari frontend) ---
    server.route({
        method: 'POST',
        path: '/api/reviews',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const { bookId, rating, message } = request.payload;
            if (!message || !message.trim()) {
                return h.response({ status: 'error', message: 'Pesan review tidak boleh kosong.' }).code(400);
            }

            const parsedBookId = bookId ? Number(bookId) : null;

            // 🟢 1 user hanya boleh review 1x per buku (review umum/bookId kosong tidak kena batasan ini)
            if (parsedBookId && stmt.findReviewByUserAndBook.get(request.auth.email, parsedBookId)) {
                return h.response({ status: 'error', message: 'Kamu sudah pernah mereview buku ini sebelumnya.', code: 'ALREADY_REVIEWED' }).code(409);
            }

            const reviewer = stmt.findUserByEmail.get(request.auth.email);
            const parsedRating = rating ? Math.min(5, Math.max(1, parseInt(rating))) : null;

            stmt.insertReview.run(
                parsedBookId,
                reviewer?.name || request.auth.email,
                request.auth.email,
                parsedRating,
                message.trim(),
                new Date().toLocaleString()
            );

            return h.response({ status: 'success', message: 'Review berhasil dikirim!' }).code(201);
        }
    });

    // --- ROUTE 10c: DAFTAR BUKU FAVORIT MILIK USER YANG LOGIN ---
    server.route({
        method: 'GET',
        path: '/api/favorites',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const rows = stmt.getFavoritesByUser.all(request.auth.email);
            return { status: 'success', data: rows.map(r => r.bookId) };
        }
    });

    // --- ROUTE 10d: TAMBAH FAVORIT ---
    server.route({
        method: 'POST',
        path: '/api/favorites',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const { bookId } = request.payload;
            if (!bookId) return h.response({ status: 'error', message: 'bookId wajib diisi.' }).code(400);

            if (!stmt.findFavorite.get(request.auth.email, Number(bookId))) {
                stmt.insertFavorite.run(request.auth.email, Number(bookId), new Date().toISOString());
            }
            return h.response({ status: 'success', message: 'Ditambahkan ke favorit.' }).code(201);
        }
    });

    // --- ROUTE 10e: HAPUS FAVORIT ---
    server.route({
        method: 'DELETE',
        path: '/api/favorites/{bookId}',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            stmt.deleteFavorite.run(request.auth.email, Number(request.params.bookId));
            return { status: 'success', message: 'Dihapus dari favorit.' };
        }
    });

    // --- ROUTE 12: AMBIL SEMUA ARTIKEL BLOG (publik, semua orang bisa baca) ---
    server.route({
        method: 'GET',
        path: '/api/blogs',
        handler: async (request, h) => {
            return { status: 'success', data: stmt.getAllBlogs.all() };
        }
    });

    // --- ROUTE 12b: TAMBAH ARTIKEL BLOG (khusus admin) ---
    server.route({
        method: 'POST',
        path: '/api/blogs',
        options: {
            pre: [{ method: requireSession }],
            payload: { output: 'stream', parse: true, multipart: true, maxBytes: 10 * 1024 * 1024 }
        },
        handler: async (request, h) => {
            if (request.auth.role !== 'admin') {
                return h.response({ status: 'error', message: 'Hanya admin yang boleh membuat artikel blog.' }).code(403);
            }

            const data = request.payload;
            if (!data.title || !data.content) {
                return h.response({ status: 'error', message: 'Judul dan isi artikel wajib diisi.' }).code(400);
            }

            let imgUrl = null;
            if (data.coverFile && data.coverFile.hapi?.filename) {
                const coverName = `blogcover_${Date.now()}_${data.coverFile.hapi.filename}`;
                const coverPath = path.join(UPLOAD_DIR, coverName);
                await new Promise((resolve, reject) => {
                    const stream = fs.createWriteStream(coverPath);
                    data.coverFile.pipe(stream);
                    data.coverFile.on('end', resolve);
                    stream.on('error', reject);
                });
                imgUrl = `http://127.0.0.1:${PORT}/uploads/${coverName}`;
            }

            const info = stmt.insertBlog.run(
                data.title,
                data.excerpt || data.content.slice(0, 150),
                data.content,
                imgUrl,
                request.auth.email,
                new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
            );

            return h.response({ status: 'success', message: 'Artikel berhasil diterbitkan!', data: { id: info.lastInsertRowid } }).code(201);
        }
    });

    // --- ROUTE 12c: EDIT ARTIKEL BLOG (khusus admin) ---
    server.route({
        method: 'PUT',
        path: '/api/blogs/{id}',
        options: {
            pre: [{ method: requireSession }],
            payload: { output: 'stream', parse: true, multipart: true, maxBytes: 10 * 1024 * 1024 }
        },
        handler: async (request, h) => {
            if (request.auth.role !== 'admin') {
                return h.response({ status: 'error', message: 'Hanya admin yang boleh mengedit artikel blog.' }).code(403);
            }

            const existing = stmt.getBlogById.get(Number(request.params.id));
            if (!existing) return h.response({ status: 'error', message: 'Artikel tidak ditemukan.' }).code(404);

            const data = request.payload;
            let imgUrl = existing.imgUrl; // tetap pakai cover lama kalau tidak upload yang baru

            if (data.coverFile && data.coverFile.hapi?.filename) {
                const coverName = `blogcover_${Date.now()}_${data.coverFile.hapi.filename}`;
                const coverPath = path.join(UPLOAD_DIR, coverName);
                await new Promise((resolve, reject) => {
                    const stream = fs.createWriteStream(coverPath);
                    data.coverFile.pipe(stream);
                    data.coverFile.on('end', resolve);
                    stream.on('error', reject);
                });
                imgUrl = `http://127.0.0.1:${PORT}/uploads/${coverName}`;
            }

            stmt.updateBlog.run(
                data.title || existing.title,
                data.excerpt || existing.excerpt,
                data.content || existing.content,
                imgUrl,
                existing.id
            );

            return { status: 'success', message: 'Artikel berhasil diperbarui!' };
        }
    });

    // --- ROUTE 12d: HAPUS ARTIKEL BLOG (khusus admin) ---
    server.route({
        method: 'DELETE',
        path: '/api/blogs/{id}',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            if (request.auth.role !== 'admin') {
                return h.response({ status: 'error', message: 'Hanya admin yang boleh menghapus artikel blog.' }).code(403);
            }

            const existing = stmt.getBlogById.get(Number(request.params.id));
            if (!existing) return h.response({ status: 'error', message: 'Artikel tidak ditemukan.' }).code(404);

            stmt.deleteBlog.run(existing.id);
            return { status: 'success', message: 'Artikel berhasil dihapus.' };
        }
    });

    // =====================================================================
    // 🔵 UPGRADE: ENTITLEMENT / ACCESS ROUTES
    // Implements: preview, borrow, unlock, purchase, protected read/download,
    // wallet (points economy), my-library, reading progress, and the admin
    // access-policy configuration endpoints. See access.js for the actual
    // business logic (canAccess, wallet, entitlements).
    // =====================================================================

    // --- ROUTE 13: PREVIEW BUKU (publik, tidak perlu login) ---
    server.route({
        method: 'GET',
        path: '/api/books/{id}/preview',
        handler: async (request, h) => {
            const book = stmt.getBookById.get(Number(request.params.id));
            if (!book) return h.response({ status: 'error', message: 'Buku tidak ditemukan.' }).code(404);

            const result = canAccess(null, book.id, 'PREVIEW');
            if (!result.allowed) {
                return h.response({ status: 'error', message: 'Preview tidak tersedia untuk buku ini.' }).code(403);
            }

            const filePath = resolveBookFilePath(book);
            if (!filePath) return h.response({ status: 'error', message: 'File buku belum tersedia.' }).code(404);

            logAccess(request.auth?.email, book.id, 'PREVIEW');
            const { token, expiresInSeconds } = issueToken(filePath, 'inline');
            return {
                status: 'success',
                data: {
                    streamUrl: `/api/files/stream/${token}`,
                    expiresInSeconds,
                    previewPages: result.previewPages, // 🟡 frontend (PDF.js) yang membatasi jumlah halaman yang dirender
                }
            };
        }
    });

    // --- ROUTE 14: BACA BUKU (full) — wajib login, dicek lewat canAccess() ---
    server.route({
        method: 'GET',
        path: '/api/books/{id}/read',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const book = stmt.getBookById.get(Number(request.params.id));
            if (!book) return h.response({ status: 'error', message: 'Buku tidak ditemukan.' }).code(404);

            const result = canAccess(request.auth.email, book.id, 'READ');
            if (!result.allowed) {
                return h.response({
                    status: 'error',
                    message: 'Kamu belum punya akses baca untuk buku ini.',
                    code: 'ACCESS_DENIED',
                    accessOptions: getBookPolicies(book.id).filter(p => p.enabled)
                }).code(403);
            }

            const filePath = resolveBookFilePath(book);
            if (!filePath) return h.response({ status: 'error', message: 'File buku belum tersedia.' }).code(404);

            logAccess(request.auth.email, book.id, 'READ');
            const { token, expiresInSeconds } = issueToken(filePath, 'inline');
            return { status: 'success', data: { streamUrl: `/api/files/stream/${token}`, expiresInSeconds, source: result.source } };
        }
    });

    // --- ROUTE 15: DOWNLOAD BUKU — wajib login + entitlement dengan izin download ---
    server.route({
        method: 'GET',
        path: '/api/books/{id}/download',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const book = stmt.getBookById.get(Number(request.params.id));
            if (!book) return h.response({ status: 'error', message: 'Buku tidak ditemukan.' }).code(404);

            const result = canAccess(request.auth.email, book.id, 'DOWNLOAD');
            if (!result.allowed) {
                return h.response({ status: 'error', message: 'Kamu tidak punya izin download untuk buku ini.', code: 'ACCESS_DENIED' }).code(403);
            }

            const filePath = resolveBookFilePath(book);
            if (!filePath) return h.response({ status: 'error', message: 'File buku belum tersedia.' }).code(404);

            logAccess(request.auth.email, book.id, 'DOWNLOAD');
            const { token, expiresInSeconds } = issueToken(filePath, 'attachment');
            return { status: 'success', data: { downloadUrl: `/api/files/stream/${token}`, expiresInSeconds } };
        }
    });

    // --- ROUTE 16: BORROW BUKU (poin, ada expires_at) ---
    server.route({
        method: 'POST',
        path: '/api/books/{id}/borrow',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => handleAcquireAccess(request, h, 'BORROW')
    });

    // --- ROUTE 17: UNLOCK BACA PREMIUM (poin, permanen) ---
    server.route({
        method: 'POST',
        path: '/api/books/{id}/unlock',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => handleAcquireAccess(request, h, 'UNLOCK_READ')
    });

    // --- ROUTE 18: PURCHASE / BELI PERMANEN (poin, permanen, bisa buka izin download) ---
    server.route({
        method: 'POST',
        path: '/api/books/{id}/purchase',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => handleAcquireAccess(request, h, 'PURCHASE')
    });

    // --- ROUTE 19: WALLET SAYA ---
    server.route({
        method: 'GET',
        path: '/api/wallet',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const wallet = getOrCreateWallet(request.auth.email);
            return { status: 'success', data: { balance: wallet.balance } };
        }
    });

    // --- ROUTE 19b: RIWAYAT TRANSAKSI POIN SAYA ---
    server.route({
        method: 'GET',
        path: '/api/wallet/transactions',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            return { status: 'success', data: getWalletTransactions(request.auth.email) };
        }
    });

    // --- ROUTE 19c: TOP UP POIN ---
    // 🟡 CATATAN MVP: belum terhubung ke payment gateway sungguhan (out of scope,
    // lihat 01_project_context.txt §8). Endpoint ini mengkredit poin secara
    // langsung untuk keperluan demo/dev; di produksi, panggilan ini akan
    // datang dari webhook penyedia pembayaran setelah pembayaran terverifikasi.
    server.route({
        method: 'POST',
        path: '/api/wallet/topup',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const amount = Number(request.payload?.amount);
            if (!amount || amount <= 0) {
                return h.response({ status: 'error', message: 'Jumlah top-up tidak valid.' }).code(400);
            }
            const balanceAfter = applyWalletTransaction({
                email: request.auth.email,
                type: 'TOPUP',
                amount,
                description: 'Top-up poin'
            });
            return h.response({ status: 'success', message: 'Top-up berhasil!', data: { balance: balanceAfter } }).code(201);
        }
    });

    // --- ROUTE 20: MY LIBRARY (semua akses aktif milik user) ---
    server.route({
        method: 'GET',
        path: '/api/my-library',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const entries = getMyLibrary(request.auth.email);
            return { status: 'success', data: entries };
        }
    });

    server.route({
        method: 'GET',
        path: '/api/my-library/borrowed',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            return { status: 'success', data: getMyLibrary(request.auth.email).filter(e => e.type === 'BORROW') };
        }
    });

    server.route({
        method: 'GET',
        path: '/api/my-library/purchased',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            return { status: 'success', data: getMyLibrary(request.auth.email).filter(e => e.type === 'PURCHASE') };
        }
    });

    // --- ROUTE 21: PROGRES BACA ---
    server.route({
        method: 'GET',
        path: '/api/books/{id}/progress',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const row = db.prepare('SELECT * FROM reading_progress WHERE email = ? AND bookId = ?')
                .get(request.auth.email, Number(request.params.id));
            return { status: 'success', data: row || null };
        }
    });

    server.route({
        method: 'PUT',
        path: '/api/books/{id}/progress',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            const { location, progressPercentage } = request.payload;
            db.prepare(`
                INSERT INTO reading_progress (email, bookId, location, progressPercentage, lastReadAt)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(email, bookId) DO UPDATE SET location = excluded.location,
                    progressPercentage = excluded.progressPercentage, lastReadAt = excluded.lastReadAt
            `).run(request.auth.email, Number(request.params.id), location || null, progressPercentage || 0, new Date().toISOString());
            return { status: 'success', message: 'Progres disimpan.' };
        }
    });

    // --- ROUTE 22: ADMIN — LIHAT/ATUR ACCESS POLICY 1 BUKU ---
    server.route({
        method: 'GET',
        path: '/api/admin/books/{id}/access-policies',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            if (request.auth.role !== 'admin') return h.response({ status: 'error', message: 'Khusus admin.' }).code(403);
            return { status: 'success', data: getBookPolicies(Number(request.params.id)) };
        }
    });

    server.route({
        method: 'PUT',
        path: '/api/admin/books/{id}/access-policies',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            if (request.auth.role !== 'admin') return h.response({ status: 'error', message: 'Khusus admin.' }).code(403);
            const bookId = Number(request.params.id);
            if (!stmt.getBookById.get(bookId)) return h.response({ status: 'error', message: 'Buku tidak ditemukan.' }).code(404);

            const policies = Array.isArray(request.payload) ? request.payload : request.payload?.policies;
            if (!Array.isArray(policies)) {
                return h.response({ status: 'error', message: 'Payload harus berupa array policy.' }).code(400);
            }
            const updated = setBookPolicies(bookId, policies);
            return { status: 'success', message: 'Access policy diperbarui.', data: updated };
        }
    });

    // --- ROUTE 23: ADMIN — SEMUA TRANSAKSI POIN (monitoring) ---
    server.route({
        method: 'GET',
        path: '/api/admin/transactions',
        options: { pre: [{ method: requireSession }] },
        handler: async (request, h) => {
            if (request.auth.role !== 'admin') return h.response({ status: 'error', message: 'Khusus admin.' }).code(403);
            return { status: 'success', data: getAllWalletTransactions() };
        }
    });

    // --- ROUTE 9: PUSTAKAWAN AI (via Groq) ---
    server.route({
        method: 'POST',
        path: '/api/ask-ai',
        handler: async (request, h) => {
            const { prompt } = request.payload;

            if (!GROQ_API_KEY) {
                console.error("AI Error: GROQ_API_KEY belum diisi di .env");
                return h.response({ status: 'error', answer: 'Lumina belum aktif — admin belum memasang API key AI di server.' }).code(500);
            }

            const systemInstruction = "Kamu adalah 'Lumina', asisten pustakawan AI yang ramah di aplikasi e-Perpusku. Tugasmu adalah merekomendasikan buku, menjawab seputar literasi, dan memberi ringkasan buku. Jawablah dengan bahasa Indonesia yang santai, gaul, namun sopan. Berikan jawaban maksimal 2-3 paragraf pendek.";

            try {
                const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${GROQ_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: GROQ_MODEL,
                        messages: [
                            { role: 'system', content: systemInstruction },
                            { role: 'user', content: prompt }
                        ],
                        temperature: 0.7,
                        max_tokens: 512
                    })
                });

                const data = await groqResponse.json();

                if (!groqResponse.ok) {
                    console.error("Groq API Error:", data);
                    const friendly = data?.error?.code === 'invalid_api_key'
                        ? 'Lumina belum aktif — API key AI di server tidak valid.'
                        : 'Maaf, otak Lumina sedang pusing. Coba lagi nanti ya!';
                    return h.response({ status: 'error', answer: friendly }).code(502);
                }

                const responseText = data.choices?.[0]?.message?.content?.trim() || 'Hmm, Lumina belum kepikiran jawabannya. Coba tanya dengan cara lain ya!';

                return h.response({ status: 'success', answer: responseText }).code(200);
            } catch (error) {
                console.error("AI Error:", error);
                return h.response({ status: 'error', answer: 'Maaf, otak Lumina sedang pusing. Coba lagi nanti ya!' }).code(500);
            }
        }
    });

    startSessionCleanup(); // 🟢 beres-beres sesi basi tiap 5 menit
    startFileTokenCleanup(); // 🔵 UPGRADE: beres-beres token file sementara yang sudah kedaluwarsa
    sweepExpiredEntitlements(); // 🔵 UPGRADE: tandai borrow yang sudah lewat expires_at saat startup
    setInterval(sweepExpiredEntitlements, 5 * 60 * 1000); // dan tiap 5 menit setelahnya

    // 🟡 DEV: kalau .env berisi SEED_TEST_USERS=true, buat akun admin & member
    // sampel otomatis di sini — tidak mengubah alur register/login/OTP sama
    // sekali, cuma menambah baris user langsung ke tabel `users` kalau belum ada.
    if (process.env.SEED_TEST_USERS === 'true') {
        await seedTestUsers();
    }

    await server.start();
    console.log('✅ Server Backend Perpusku (SQLite) nyala di %s', server.info.uri);
};

init();
