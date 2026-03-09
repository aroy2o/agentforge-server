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
const libreTranslateService = require('./services/libreTranslateService');
const chromaService = require('./services/chromaService');

const chatRoutes = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());

// Routes
app.use('/api/agent', agentRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/user', userDataRoutes);
app.use('/api/chat', chatRoutes);


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

// Graceful cleanup
const cleanShutdown = () => {
    console.log('\n[Server] Shutting down...');
    schedulerService.stopAll();
    libreTranslateService.stopLibreTranslate();
    chromaService.stopChromaServer();
    process.exit();
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
            await chromaService.startChromaServer();
        } catch (err) {
            console.warn('[Server] ChromaDB spawn error:', err.message);
        }

        // Initialize ChromaDB RAG Vector Store
        await chromaService.initialize();

        // Boot LibreTranslate locally in the background
        try {
            await libreTranslateService.startLibreTranslate();
        } catch (err) {
            console.warn('[Server] LibreTranslate engine failed to start.', err.message);
        }

        // Boot Scheduler Service
        await schedulerService.loadAndStartAll();
    });
})();
