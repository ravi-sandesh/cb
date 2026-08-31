FROM node:24-alpine

WORKDIR /app
COPY web/package.json ./
RUN npm install --production || echo "no external deps"
COPY . .

ENV PORT=${PORT}
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 3111

CMD ["node", "web/online/online-server.js"]
