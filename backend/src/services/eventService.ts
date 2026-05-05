import { Server } from 'socket.io';
import axios from 'axios';
import pool from '../config/db';

let io: Server;

export const initEventService = (server: any) => {
  io = new Server(server, {
    cors: { origin: '*' }
  });

  io.on('connection', (socket: any) => {
    console.log('[Socket] Client connected:', socket.id);
    
    // Join tenant room based on JWT (simplified for POC)
    socket.on('join-tenant', (tenantId: string) => {
      socket.join(`tenant_${tenantId}`);
      console.log(`[Socket] Client ${socket.id} joined room tenant_${tenantId}`);
    });
  });

  // Start listening for Postgres NOTIFY
  listenForPostgresEvents();
};

const listenForPostgresEvents = async () => {
  const client = await pool.connect();
  await client.query('LISTEN data_fabric_events');

  client.on('notification', async (msg) => {
    if (!msg.payload) return;
    const payload = JSON.parse(msg.payload);
    
    console.log('[Event] Broadcasing to UI:', payload);
    
    // 1. Emit to Socket.io room
    if (payload.tenant_id) {
      io.to(`tenant_${payload.tenant_id}`).emit('fabric-event', payload);
    } else {
      io.emit('fabric-event', payload);
    }

    // 2. Dispatch to external webhooks (Example logic)
    // dispatchWebhook(payload);
  });
};

const dispatchWebhook = async (payload: any) => {
  // Logic to fetch registered webhooks for the tenant and POST data to them
  console.log('[Webhook] Dispatching event to external service...');
};
