require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const { connectDB } = require('./database/connection');
const agentRoutes = require('./routes/agent');
const toolsRoutes = require('./routes/tools');
const voiceRoutes = require('./routes/voice');
const authRoutes = require('./routes/auth');
const exportRoutes = require('./routes/export');
const userDataRoutes = require('./routes/userData');
const integrationsRoutes = require('./routes/integrations');
const permissionsRoutes = require('./routes/permissions');
const notificationsRoutes = require('./routes/notifications');
const libreTranslateService = require('./services/libreTranslateService');
const chromaService = require('./services/chromaService');

const chatRoutes = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Routes
app.use('/api/agent', agentRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/user', userDataRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/notifications', notificationsRoutes);


// Health check — includes live DB connection state
app.get('/health', (req, res) => {
    const dbConnected = mongoose.connection.readyState === 1;
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: { connected: dbConnected },
    });
});

const schedulerService = require('./services/schedulerService');

function bootLibreTranslateInBackground() {
    (async () => {
        try {
            let ltReady = await libreTranslateService.startLibreTranslate({ timeoutMs: 25000 });
            if (!ltReady) {
                console.warn('[Server] LibreTranslate not ready on first attempt. Retrying once...');
                await new Promise((r) => setTimeout(r, 4000));
                ltReady = await libreTranslateService.startLibreTranslate({ timeoutMs: 15000 });
            }

            if (!ltReady) {
                console.warn('[Server] LibreTranslate still not ready. Using fallback translation behavior until engine becomes available.');
            }
        } catch (err) {
            console.warn('[Server] LibreTranslate engine failed to start.', err.message);
        }
    })();
}

// Graceful cleanup
let isShuttingDown = false;
const cleanShutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('\n[Server] Shutting down...');
    schedulerService.stopAll();

    const forceExit = setTimeout(() => {
        process.exit(1);
    }, 9000);

    try {
        await Promise.allSettled([
            libreTranslateService.stopLibreTranslate(),
            chromaService.stopChromaServer(),
        ]);
    } finally {
        clearTimeout(forceExit);
        process.exit(0);
    }
};

process.on('SIGINT', cleanShutdown);
process.on('SIGTERM', cleanShutdown);

// Bootstrap: connect to DB first, then start listening
(async () => {
    await connectDB();          // exits process on failure — server never starts without DB

    app.listen(PORT, async () => {
        console.log(`AgentForge Server listening on port ${PORT}`);

        // Start Python Chroma DB
        try {
            let chromaReady = await chromaService.startChromaServer();
            if (!chromaReady) {
                console.warn('[Server] ChromaDB not ready on first attempt. Retrying once...');
                await new Promise((r) => setTimeout(r, 3000));
                chromaReady = await chromaService.startChromaServer();
            }
        } catch (err) {
            console.warn('[Server] ChromaDB spawn error:', err.message);
        }

        // Initialize ChromaDB RAG Vector Store
        await chromaService.initialize();

        // Boot LibreTranslate without blocking scheduler startup.
        bootLibreTranslateInBackground();

        // Boot Scheduler Service
        await schedulerService.loadAndStartAll();
    });
})();
