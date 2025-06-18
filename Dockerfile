FROM node:18

# Install Chromium and dependencies for Puppeteer
RUN apt-get update && \
    apt-get install -y wget ca-certificates fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 libxcomposite1 libxdamage1 libxrandr2 \
    xdg-utils chromium-browser --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy all source code
COPY . .

# Expose the default port
EXPOSE 3000

# Set Puppeteer to use system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]
CMD ["npm", "start"]
