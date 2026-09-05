// 🟡 DEV/TESTING ONLY — bukan bagian dari alur produksi.
// Membuat akun admin & member langsung di database, melewati proses
// kirim-OTP-lewat-email (berguna untuk testing lokal tanpa perlu setup
// SMTP/Gmail App Password dulu).
//
// Cara pakai #1 (manual, jalankan sekali):
//   cd backend-perpusku
//   node src/seed-test-users.js
//
// Cara pakai #2 (otomatis tiap kali server start, TANPA jalanin apapun manual):
//   Tambahkan baris ini di .env:
//       SEED_TEST_USERS=true
//   Lalu `npm start` seperti biasa — akun otomatis dibuat kalau belum ada.
//   Lihat pemanggilan seedTestUsers() di server.js bagian init().
//
// Kredensial yang dibuat:
//   Admin  : admin@test.com  / password123
//   Member : member@test.com / password123
//
// Aman dipanggil berkali-kali — kalau email sudah ada, akan dilewati saja.

import bcrypt from 'bcryptjs';
import db from './db.js';

const SALT_ROUNDS = 10;

const users = [
    { name: 'Admin Test', email: 'admin@test.com', password: 'password123', role: 'admin' },
    { name: 'Member Test', email: 'member@test.com', password: 'password123', role: 'member' },
];

const findUser = db.prepare('SELECT * FROM users WHERE email = ?');
const insertUser = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)');

// 🔵 Diekspor supaya bisa dipanggil dari server.js saat startup (Cara pakai #2)
export const seedTestUsers = async () => {
    for (const u of users) {
        if (findUser.get(u.email)) {
            console.log(`🌱 [seed] ${u.email} sudah ada, dilewati.`);
            continue;
        }
        const hashed = await bcrypt.hash(u.password, SALT_ROUNDS);
        insertUser.run(u.name, u.email, hashed, u.role);
        console.log(`🌱 [seed] Dibuat: ${u.email} (role: ${u.role}) — password: ${u.password}`);
    }
};

// Tetap bisa dijalankan langsung sebagai script mandiri: `node src/seed-test-users.js`
// (import.meta.url === entry point yang dieksekusi -> berarti dipanggil manual, bukan di-import)
if (import.meta.url === `file://${process.argv[1]}`) {
    seedTestUsers().then(() => {
        console.log('\nSelesai. Login lewat POST /api/login atau langsung dari frontend.');
    });
}

