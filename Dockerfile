FROM node:20-alpine

WORKDIR /app

# Install production deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

# Persistent state goes on the mounted volume at /app/data
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["npm", "start"]
