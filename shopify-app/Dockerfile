FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Generate the client at build time. Database changes are a separate release step.
RUN npm run setup && npm run build

CMD ["npm", "run", "docker-start"]
