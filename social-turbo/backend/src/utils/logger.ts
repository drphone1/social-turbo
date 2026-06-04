import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { broadcastLog } from '../websocket/ws.handler';

const logDir = path.join(process.cwd(), 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create custom transport for WebSocket broadcasting
const websocketTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.printf(({ level, message }: { level: string; message: unknown }) => {
      // Broadcast to WebSocket clients
      broadcastLog(level.toString(), String(message));
      return '';
    })
  ),
  silent: true, // Don't output to console
});

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf((info) => {
      const { timestamp, level, message } = info as { timestamp: string, level: string, message: any };
      // Broadcast to WebSocket clients
      broadcastLog(String(level), String(message));
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.colorize(),
    }),
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
  ],
});
