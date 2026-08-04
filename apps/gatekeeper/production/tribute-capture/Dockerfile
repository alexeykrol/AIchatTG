FROM node:20.20.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src/ ./src/
RUN mkdir -p /data/receipts && chown -R node:node /data

USER node
EXPOSE 3100
CMD ["node", "src/server.js"]
