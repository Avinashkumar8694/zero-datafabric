import bcrypt from 'bcrypt';

const password = 'admin';
const hash = '$2b$10$EPZ9S.C.mC8N7hYVj6n7OeB.K1OQ/R7/h7CjY6Z1q2F8gV5X5.K.K';

async function check() {
    const match = await bcrypt.compare(password, hash);
    console.log('Password match:', match);
    
    const newHash = await bcrypt.hash(password, 10);
    console.log('New hash generated:', newHash);
}

check();
