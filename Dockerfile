FROM node:20-slim AS builder

WORKDIR /chat-analytics

COPY package.json .
COPY bun.lock .

RUN npm install

COPY app app
COPY assets assets
COPY lib lib
COPY pipeline pipeline
COPY report report
COPY tsconfig.json .
COPY tsconfig.node.json .
COPY tsconfig.web.json .
COPY webpack.config.js .

ENV SELF_HOSTED=1
RUN npm run build:web
RUN npm run build:node

FROM node:20-alpine

# Install nginx
RUN apk add --no-cache nginx

WORKDIR /chat-analytics

# Copy built assets and CLI
COPY --from=builder /chat-analytics/dist_web /usr/share/nginx/html
COPY --from=builder /chat-analytics/dist /chat-analytics/dist
COPY --from=builder /chat-analytics/assets /chat-analytics/assets
COPY --from=builder /chat-analytics/dist_web /chat-analytics/dist_web
COPY --from=builder /chat-analytics/node_modules /chat-analytics/node_modules

# Copy and setup entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Setup nginx config for alpine
COPY nginx.conf /etc/nginx/http.d/default.conf
RUN mkdir -p /run/nginx

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
