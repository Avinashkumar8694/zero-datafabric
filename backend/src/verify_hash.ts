import bcrypt from 'bcrypt';

async function verify() {
    const raw = 'admin';
    const hash = '$2b$10$CxBK2AyOtIyt4hCsEZPqEOhGQloahPxyalyChP9hNprweiD/4PZY2';
    const match = await bcrypt.compare(raw, hash);
    console.log(`Match for 'admin': ${match}`);
    
    // Generate a fresh one just in case
    const newHash = await bcrypt.hash('admin', 10);
    console.log(`Fresh hash for 'admin': ${newHash}`);
}

verify();
