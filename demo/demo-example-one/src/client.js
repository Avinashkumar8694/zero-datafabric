/**
 * Zero Data Fabric API Client for demo-example-one
 */
const axios = require('axios');
const FormData = require('form-data');

class DataFabricClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.DF_API_URL || 'http://127.0.0.1:4000/api';
    this.username = options.username || process.env.DF_USER || 'admin';
    this.password = options.password || process.env.DF_PASS || 'admin';
    this.tenantId = options.tenantId || process.env.DF_TENANT || 'tenant_A';
    this.token = null;
  }

  async authenticate() {
    try {
      const res = await axios.post(`${this.baseUrl}/auth/login`, {
        username: this.username,
        password: this.password
      });
      this.token = res.data?.token;
      if (!this.token) throw new Error('Authentication succeeded but token was missing');
      return this.token;
    } catch (err) {
      throw new Error(`Auth failed (${err.response?.status || 'Network'}): ${JSON.stringify(err.response?.data || err.message)}`);
    }
  }

  getHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      'x-tenant-id': this.tenantId,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async diff(manifest) {
    if (!this.token) await this.authenticate();
    const form = new FormData();
    form.append('file', Buffer.from(JSON.stringify(manifest, null, 2)), {
      filename: 'manifest.json',
      contentType: 'application/json'
    });

    const res = await axios.post(`${this.baseUrl}/metadata/diff`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${this.token}`,
        'x-tenant-id': this.tenantId
      }
    });
    return res.data;
  }

  async apply(manifest, force = true) {
    if (!this.token) await this.authenticate();
    const form = new FormData();
    form.append('file', Buffer.from(JSON.stringify(manifest, null, 2)), {
      filename: 'manifest.json',
      contentType: 'application/json'
    });

    const url = `${this.baseUrl}/metadata/apply${force ? '?force=true' : ''}`;
    const res = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${this.token}`,
        'x-tenant-id': this.tenantId
      }
    });
    return res.data;
  }

  async query(queryConfig) {
    if (!this.token) await this.authenticate();
    const res = await axios.post(`${this.baseUrl}/analytics/query`, {
      queryConfig
    }, {
      headers: this.getHeaders()
    });
    return res.data;
  }

  async insert(schema, table, data) {
    return this.query({
      type: 'INSERT',
      schema,
      table,
      data
    });
  }

  async select(schema, resource, options = {}) {
    const query = {
      from: { resource },
      select: options.select || ['*'],
      where: options.where,
      joins: options.joins,
      orderBy: options.orderBy,
      groupBy: options.groupBy
    };
    return this.query({
      type: 'SELECT',
      schema,
      limit: options.limit || 50,
      query
    });
  }

  async update(schema, table, data, filter) {
    return this.query({
      type: 'UPDATE',
      schema,
      table,
      data,
      filter
    });
  }

  async delete(schema, table, filter) {
    return this.query({
      type: 'DELETE',
      schema,
      table,
      filter
    });
  }

  async refreshView(viewName, schema = 'Payment_MS') {
    if (!this.token) await this.authenticate();
    const res = await axios.post(`${this.baseUrl}/analytics/refresh-view`, {
      viewName,
      schema,
      concurrent: false
    }, {
      headers: this.getHeaders()
    });
    return res.data;
  }

  async get(endpoint, options = {}) {
    if (!this.token) await this.authenticate();
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
    const res = await axios.get(url, {
      headers: this.getHeaders(options.headers || {}),
      params: options.params
    });
    return res.data;
  }

  async post(endpoint, data = {}, options = {}) {
    if (!this.token) await this.authenticate();
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
    const res = await axios.post(url, data, {
      headers: this.getHeaders(options.headers || {})
    });
    return res.data;
  }

  async queryStream(queryConfig) {
    if (!this.token) await this.authenticate();
    const res = await axios.post(`${this.baseUrl}/analytics/query`, {
      stream: true,
      queryConfig
    }, {
      headers: this.getHeaders({
        Accept: 'application/x-ndjson'
      }),
      responseType: 'text'
    });
    return res.data;
  }

  async callFunction(fnName, args = [], schema = 'Payment_MS') {
    return this.post('/data/call', {
      schema,
      function: fnName,
      args
    });
  }

  async callProcedure(procName, args = [], schema = 'Payment_MS') {
    return this.post('/data/call', {
      schema,
      procedure: procName,
      args
    });
  }

  async fetchData(resource, options = {}, schema = 'Payment_MS') {
    return this.post('/data/fetch', {
      schema,
      resource,
      columns: options.columns,
      where: options.where,
      orderBy: options.orderBy,
      limit: options.limit || 50,
      offset: options.offset
    });
  }

  async createData(resource, data, schema = 'Payment_MS') {
    return this.post('/data/create', {
      schema,
      resource,
      data
    });
  }

  async updateData(resource, where, data, schema = 'Payment_MS') {
    return this.post('/data/update', {
      schema,
      resource,
      where,
      data
    });
  }

  async deleteData(resource, where, schema = 'Payment_MS') {
    return this.post('/data/delete', {
      schema,
      resource,
      where
    });
  }

  async nextSequence(name, start = 1, increment = 1) {
    return this.post('/data/sequence', {
      name,
      start,
      increment
    });
  }
}

module.exports = DataFabricClient;
