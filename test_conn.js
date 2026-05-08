const { Client } = require('pg');

async function test() {
  const client = new Client({
    host: 'localhost',
    port: 5434,
    user: 'fabric_admin',
    password: 'fabric_password',
    database: 'datafabric'
  });
  try {
    await client.connect();
    console.log('Connected successfully with hardcoded fabric_password');
    await client.end();
  } catch (err) {
    console.error('Connection Failed:', err.message);
    process.exit(1);
  }
}

test();
