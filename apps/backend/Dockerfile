FROM node:20-alpine AS builder
WORKDIR /app
# instala openssl para o prisma generate funcionar no builder
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# openssl1.1-compat resolve o libssl.so.1.1 que o Prisma 5.x precisa no Alpine
RUN apk add --no-cache dumb-init openssl1.1-compat
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD sh -c "until npx prisma db push --accept-data-loss 2>&1; do echo 'Aguardando banco...'; sleep 5; done && node dist/index.js"
