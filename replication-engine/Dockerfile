FROM node:20-alpine
WORKDIR /app
# Install backend dependencies first (since replication-engine imports backend modules)
COPY backend/package*.json ./backend/
RUN npm ci --prefix backend
# Install replication-engine dependencies
COPY replication-engine/package*.json ./replication-engine/
RUN npm ci --prefix replication-engine
COPY . .
CMD ["npm", "--prefix", "replication-engine", "start"]
