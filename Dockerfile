# Stage 1: Build Mintlify static site
FROM node:22-alpine AS builder

WORKDIR /app

COPY . .

RUN npx mintlify export --output export.zip && \
    mkdir -p /app/output && \
    unzip export.zip -d /app/output && \
    rm export.zip

# Stage 2: Runtime with auth server
FROM oven/bun:1-alpine

WORKDIR /app

COPY server/package.json server/bun.lock* ./

RUN bun install --production

COPY server/index.js ./index.js

# Copy built static site from builder
COPY --from=builder /app/output ./static

ENV NODE_ENV=production
ENV STATIC_DIR=/app/static
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "index.js"]
