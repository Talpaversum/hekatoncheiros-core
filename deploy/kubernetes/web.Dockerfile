FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY hekatoncheiros-web/package*.json ./
RUN npm ci
COPY hekatoncheiros-web/index.html hekatoncheiros-web/postcss.config.js hekatoncheiros-web/tailwind.config.js ./
COPY hekatoncheiros-web/tsconfig.json hekatoncheiros-web/tsconfig.app.json hekatoncheiros-web/tsconfig.node.json hekatoncheiros-web/vite.config.ts ./
COPY hekatoncheiros-web/public ./public
COPY hekatoncheiros-web/src ./src
ARG VITE_API_BASE=/api/v1
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY hekatoncheiros-core/deploy/kubernetes/web-nginx.conf /etc/nginx/conf.d/default.conf
RUN touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/cache/nginx /var/run/nginx.pid /usr/share/nginx/html
USER nginx
EXPOSE 8080
