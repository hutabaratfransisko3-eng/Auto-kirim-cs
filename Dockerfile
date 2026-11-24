# Gunakan image resmi Node.js v20 yang ringan dan stabil
FROM node:20-slim

# Set direktori kerja di dalam container
WORKDIR /app

# Salin package.json dan install dependencies terlebih dahulu (optimasi cache Docker)
COPY package*.json ./
RUN npm install --production

# Salin seluruh kode proyek
COPY . .

# Jalankan bot
CMD ["npm", "start"]
