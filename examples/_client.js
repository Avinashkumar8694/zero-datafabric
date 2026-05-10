/* eslint-disable no-console */
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4000/api';
const TENANT_ID = process.env.TENANT_ID || 'tenant_A';
const USERNAME = process.env.DF_USER || 'admin';
const PASSWORD = process.env.DF_PASS || 'admin';

async function login() {
  const res = await axios.post(`${BASE_URL}/auth/login`, { username: USERNAME, password: PASSWORD });
  const token = res.data?.token;
  if (!token) throw new Error('Login failed: token missing');
  return token;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_ID,
    'Content-Type': 'application/json'
  };
}

async function call(name, reqFn, { allowFail = false } = {}) {
  const started = Date.now();
  try {
    const out = await reqFn();
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
    return out;
  } catch (err) {
    const msg = err.response?.data || err.message;
    if (allowFail) {
      console.log(`WARN ${name} (${Date.now() - started}ms)`);
      console.log(msg);
      return null;
    }
    console.log(`FAIL ${name} (${Date.now() - started}ms)`);
    console.log(msg);
    throw err;
  }
}

function banner(title) {
  console.log(`\n=== ${title} ===`);
}

module.exports = {
  BASE_URL,
  TENANT_ID,
  login,
  authHeaders,
  call,
  banner
};

