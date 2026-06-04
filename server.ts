import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import next from 'next';
import { parse } from 'url';
import path from 'path';
import fs from 'fs';
import { logger } from './backend/src/utils/logger';
import { initializeDatabase } from './backend/src/database';
import { setupWebSocket } from './backend/src/websocket/ws.handler';
import { setupRoutes } from './backend/src/routes/index';
import { startQueueWorker } from './backend/src/modules/queue/queue.service';
import { startNetworkDiagnosticsMonitor } from './backend/src/modules/whatsapp/baileys.service';
import { initializeRateLimiter } from './backend/src/modules/whatsapp/rate-limiter';

const lifecycleEvent = process.env.npm_lifecycle_event;
const resolvedNodeEnv = process.env.NODE_ENV || (lifecycleEvent === 'build' || lifecycleEvent === 'start' ? 'production' : 'development');
const dev = resolvedNodeEnv !== 'production';
const hostname = 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function bootstrap() {
  try {
    logger.info('Starting WhatsApp Turbo CRM Server...');

    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // 1. Initialize Database
    await initializeDatabase();

    // 2. Prepare Next.js
    await app.prepare();

    // 3. Setup Express Server
    const serverApp = express();
    serverApp.use('/api', express.json());
    serverApp.use('/uploads', express.static(uploadsDir));

    // 4. Initialize Rate Limiter
    initializeRateLimiter();

    // 5. Setup API Routes
    setupRoutes(serverApp);

    // 6. Next.js Catch-all
    serverApp.all(/.*/, (req, res) => {
      const parsedUrl = parse(req.url!, true);
      handle(req, res, parsedUrl);
    });

    const server = createServer(serverApp);

    // 7. Setup WebSocket Server
    const wss = new WebSocketServer({ noServer: true });
    setupWebSocket(wss);

    server.on('upgrade', (req, socket, head) => {
      const { pathname } = parse(req.url || '', true);
      if (pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        app.getUpgradeHandler()(req, socket, head);
      }
    });

    // 8. Start Queue Worker
    startQueueWorker();

    // 8.1. Start network diagnostics monitor
    startNetworkDiagnosticsMonitor();

    // 9. Start Server
    server.listen(port, () => {
      logger.info(`Server ready on port ${port}`);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
