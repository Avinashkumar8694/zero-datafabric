FROM node:20-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --legacy-peer-deps
COPY backend/ ./
COPY developer_docs /app/developer_docs
EXPOSE 4000
CMD ["npm", "start"]
