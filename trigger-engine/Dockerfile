FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 4001
CMD ["npx", "ts-node", "--transpile-only", "src/index.ts"]
