// 🟢 Jalankan sekali saja: node src/hash-existing-passwords.js
// Untuk database yang sudah dimigrasi SEBELUM fitur hashing ini dipasang,
// script ini akan mencari password yang masih plaintext (belum berbentuk hash bcrypt,
// yang selalu diawali "$2") dan menggantinya jadi hash.
import bcrypt from 'bcryptjs';
import db from './db.js';

const SALT_ROUNDS = 10;

const run = async () => {
    const users = db.prepare('SELECT * FROM users').all();
    const update = db.prepare('UPDATE users SET password = ? WHERE id = ?');

    let hashedCount = 0;
    for (const user of users) {
        const isAlreadyHashed = typeof user.password === 'string' && user.password.startsWith('$2');
        if (isAlreadyHashed) continue;

        const hashed = await bcrypt.hash(user.password, SALT_ROUNDS);
        update.run(hashed, user.id);
        hashedCount++;
        console.log(`🔒 Password untuk ${user.email} sudah di-hash.`);
    }

    if (hashedCount === 0) {
        console.log('✅ Semua password sudah dalam bentuk hash, tidak ada yang perlu diubah.');
    } else {
        console.log(`✅ Selesai. ${hashedCount} password berhasil di-hash.`);
    }
};

run();
