FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules/
COPY dist/ ./dist/
COPY public/ ./public/
EXPOSE 3000
CMD ["node", "dist/server.js"]
