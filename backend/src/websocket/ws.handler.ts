import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger';

let wssInstance: WebSocketServer | null = null;

export function setupWebSocket(wss: WebSocketServer) {
  wssInstance = wss;
  
  wss.on('connection', (ws: WebSocket) => {
    logger.info('New WebSocket connection');
    
    ws.on('message', (message) => {
      logger.info(`Received message: ${message}`);
    });
    
    ws.on('close', () => {
      logger.info('WebSocket disconnected');
    });
  });
}

export function broadcast(event: string, data: any) {
  if (!wssInstance) return;
  
  const payload = JSON.stringify({ event, data });
  wssInstance.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

export function broadcastLog(level: string, message: string) {
  if (!wssInstance) return;
  
  const payload = JSON.stringify({ 
    event: 'log', 
    data: { 
      level, 
      message,
      timestamp: new Date().toISOString()
    } 
  });
  
  wssInstance.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}
