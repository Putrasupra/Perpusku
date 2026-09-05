// 🟢 Jalankan sekali saja: node src/migrate.js
// Script ini membaca database.json lama dan memasukkan isinya ke database.sqlite
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import db from './db.js';

const SALT_ROUNDS = 10;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OLD_DB_PATH = path.join(__dirname, '..', 'database.json');

const run = async () => {
  if (!fs.existsSync(OLD_DB_PATH)) {
    console.log('⚠️  database.json tidak ditemukan, tidak ada yang perlu dimigrasikan.');
    return;
  }

  const old = await fs.readJson(OLD_DB_PATH);
  let count = { users: 0, otps: 0, books: 0, feedbacks: 0 };

  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (name, email, password, role) VALUES (?, ?, ?, ?)'
  );
  for (const u of old.users || []) {
    // 🟢 database.json lama menyimpan password polos -> di-hash dulu sebelum masuk SQLite
    const alreadyHashed = typeof u.password === 'string' && u.password.startsWith('$2');
    const password = alreadyHashed ? u.password : await bcrypt.hash(u.password, SALT_ROUNDS);
    insertUser.run(u.name, u.email, password, u.role || 'member');
    count.users++;
  }

  const insertOtp = db.prepare(
    'INSERT INTO otps (email, otp, name, password, type, expires) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const o of old.otps || []) {
    insertOtp.run(o.email, o.otp, o.name || null, o.password || null, o.type, o.expires);
    count.otps++;
  }

  const insertBook = db.prepare(
    'INSERT OR IGNORE INTO books (id, title, author, rating, category, description, coverUrl, pdfUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const b of old.books || []) {
    insertBook.run(b.id, b.title, b.author, b.rating, b.category, b.description, b.coverUrl, b.pdfUrl);
    count.books++;
  }

  const insertFeedback = db.prepare(
    'INSERT OR IGNORE INTO feedbacks (id, name, email, message, date) VALUES (?, ?, ?, ?, ?)'
  );
  for (const f of old.feedbacks || []) {
    insertFeedback.run(f.id, f.name, f.email, f.message, f.date);
    count.feedbacks++;
  }

  console.log('✅ Migrasi selesai!');
  console.log(`   Users: ${count.users}, OTPs: ${count.otps}, Books: ${count.books}, Feedbacks: ${count.feedbacks}`);
  console.log('   File database.sqlite sudah siap dipakai oleh server.js');
};

run();
