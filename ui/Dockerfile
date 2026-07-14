FROM node:20-alpine
WORKDIR /app/ui
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3001
CMD ["npx", "ts-node", "src/index.ts"]
