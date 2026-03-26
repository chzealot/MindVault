FROM node:20-alpine AS builder

WORKDIR /app

COPY . .

RUN npx mintlify build

FROM nginx:alpine

COPY --from=builder /app/.mintlify/output /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
