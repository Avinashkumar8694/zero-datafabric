FROM node:20-alpine
WORKDIR /app/trigger-engine
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
EXPOSE 4001
CMD ["npx", "ts-node", "--transpile-only", "src/index.ts"]
