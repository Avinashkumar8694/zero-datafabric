FROM node:20-alpine
WORKDIR /app/trigger-engine
COPY trigger-engine/package*.json ./
RUN npm ci --legacy-peer-deps
COPY trigger-engine/ ./
EXPOSE 4001
CMD ["npm", "start"]
