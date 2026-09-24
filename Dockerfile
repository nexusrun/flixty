FROM node:20-alpine

WORKDIR /app

# ffmpeg/ffprobe build AI videos (image-compose fallback) and burn in captions
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data/uploads

EXPOSE 3000

CMD ["node", "server.js"]
