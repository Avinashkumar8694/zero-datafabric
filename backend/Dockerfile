FROM node:20-alpine
WORKDIR /app/backend
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
EXPOSE 4000
CMD ["npx", "ts-node", "src/index.ts"]
