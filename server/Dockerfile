# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy only package files first (for better caching)
COPY package*.json ./

# Install deps (omit dev only in production)
ARG NODE_ENV=production
RUN if [ "$NODE_ENV" = "production" ]; then \
      npm ci --omit=dev || npm install --omit=dev; \
    else \
      npm install; \
    fi

# Copy app code
COPY . .

# Expose ports for app and debugger
EXPOSE 4000 9229

# Default command (can be overridden in docker-compose)
CMD ["npm", "start"]
