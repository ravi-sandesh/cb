FROM node:24-alpine

# The server has zero production dependencies (node:sqlite + node:http are
# built in; web/package.json holds dev-only tooling), so there is deliberately
# no npm install layer. .dockerignore keeps secrets, databases, build output
# and test artifacts out of the image.
WORKDIR /app
COPY . .

RUN cd web && npm ci && npm run build

ENV PORT=${PORT}
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 3111

CMD ["node", "web/online/online-server.js"]
