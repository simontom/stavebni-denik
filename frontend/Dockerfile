FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY frontend/ ./frontend/
WORKDIR /app/frontend
RUN pnpm build

FROM nginx:alpine
COPY --from=builder /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
