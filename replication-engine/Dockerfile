FROM node:20-alpine
WORKDIR /app/replication-engine
COPY replication-engine/package*.json ./
RUN npm ci --legacy-peer-deps
COPY replication-engine/ ./
EXPOSE 4002
CMD ["npm", "start"]
