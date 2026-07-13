FROM node:20-alpine
WORKDIR /app
# Install backend dependencies first (since replication-engine imports backend modules)
COPY backend/package*.json ./backend/
RUN npm ci --prefix backend --legacy-peer-deps
# Install replication-engine dependencies
COPY replication-engine/package*.json ./replication-engine/
RUN npm ci --prefix replication-engine --legacy-peer-deps
COPY . .
CMD ["npm", "--prefix", "replication-engine", "start"]
