# Stage 1: Build Mintlify static site
FROM node:20-alpine AS builder

WORKDIR /app

COPY . .

RUN npx mintlify build

# Stage 2: Runtime with auth server
FROM node:20-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json* ./

RUN npm install --omit=dev

COPY server/index.js ./index.js

# Copy built static site from builder
COPY --from=builder /app/.mintlify/output ./static

ENV NODE_ENV=production
ENV STATIC_DIR=/app/static
ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]
