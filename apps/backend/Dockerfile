FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init openssl

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/index.js"]