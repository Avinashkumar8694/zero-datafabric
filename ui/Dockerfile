FROM node:20-alpine
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
EXPOSE 3001
CMD ["npm", "start"]
