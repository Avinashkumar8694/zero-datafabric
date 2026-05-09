import { Kafka } from 'kafkajs';
import { pool } from '../config/database';

const kafka = new Kafka({
  clientId: 'data-fabric-hub',
  brokers: [process.env.KAFKA_BROKERS || 'localhost:9092'],
});

const consumer = kafka.consumer({ groupId: 'fabric-group' });

export const startConsumer = async () => {
  await consumer.connect();
  await consumer.subscribe({ topic: /cdc\..*/, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }: any) => {
      if (!message.value) return;
      
      const payload = JSON.parse(message.value.toString());
      console.log(`[CDC Event] Received from ${topic}:`, payload);
      
      // In a real implementation, you would map this payload to the internal schema
      // and perform an UPSERT into the Hub database.
      
      // Example: broadcast via Postgres NOTIFY for real-time UI updates
      await pool.query('SELECT pg_notify($1, $2)', ['data_fabric_events', JSON.stringify({
        source: topic,
        operation: payload.op,
        data: payload.after
      })]);
    },
  });
};
