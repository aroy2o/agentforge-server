const { ChromaClient } = require('chromadb');
const axios = require('axios');
const { spawn } = require('child_process');
const net = require('net');

let client = null;
let collection = null;
let chromaProcess = null;
let reconnectTimer = null;
let shuttingDown = false;

let activeChromaUrl = process.env.CHROMA_URL || 'http://127.0.0.1:8000';

function parseChromaUrl(url) {
    try {
        const parsed = new URL(url);
        return {
            host: parsed.hostname || 'localhost',
            port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
            ssl: parsed.protocol === 'https:',
            protocol: parsed.protocol,
        };
    } catch {
        return { host: 'localhost', port: 8000, ssl: false, protocol: 'http:' };
    }
}

function getChromaHealthUrl() {
    return `${activeChromaUrl}/api/v2/heartbeat`;
}

async function isChromaHealthy(timeout = 1000) {
    try {
        const res = await axios.get(getChromaHealthUrl(), { timeout });
        return res.status === 200;
    } catch {
        return false;
    }
}

async function isChromaHealthyAt(url, timeout = 1000) {
    try {
        const res = await axios.get(`${url}/api/v2/heartbeat`, { timeout });
        return res.status === 200;
    } catch {
        return false;
    }
}

function isPortAvailable(host, port) {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => {
                tester.close(() => resolve(true));
            })
            .listen(port, host);
    });
}

function getCandidatePorts(defaultPort) {
    const explicit = String(process.env.CHROMA_PORT_CANDIDATES || '')
        .split(',')
        .map((p) => Number(String(p).trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

    if (explicit.length > 0) return [...new Set(explicit)];

    const scanCount = Math.max(1, Number(process.env.CHROMA_PORT_SCAN || 30));
    const startPort = Number(process.env.CHROMA_PORT_START || defaultPort || 8000);
    return Array.from({ length: scanCount }, (_, i) => startPort + i).filter((p) => p < 65536);
}

async function waitForChromaHealth(timeoutMs = Number(process.env.CHROMA_STARTUP_TIMEOUT_MS || 45000), pollMs = 1000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await isChromaHealthy()) return true;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
}

function scheduleReconnect(delayMs = 15000) {
    if (shuttingDown) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        await initialize();
    }, delayMs);
}

function startChromaServer() {
    return new Promise((resolve) => {
        const launch = async () => {
            if (chromaProcess) {
                const healthy = await waitForChromaHealth();
                if (!healthy) {
                    console.warn('[ChromaDB] Existing process did not become healthy in time.');
                }
                resolve(healthy);
                return;
            }

            console.log('[ChromaDB] Spawning local instance...');

            // If a Chroma instance is already running (external or prior), don't spawn another.
            if (await isChromaHealthy()) {
                console.log('[ChromaDB] Existing instance detected and healthy.');
                resolve(true);
                return;
            }

            const parsed = parseChromaUrl(activeChromaUrl);
            const host = process.env.CHROMA_HOST || parsed.host || '127.0.0.1';
            const candidatePorts = getCandidatePorts(parsed.port);

            // Reuse any already-running healthy Chroma in the candidate set.
            for (const p of candidatePorts) {
                const candidateUrl = `${parsed.protocol}//${host}:${p}`;
                if (await isChromaHealthyAt(candidateUrl, 600)) {
                    activeChromaUrl = candidateUrl;
                    console.log(`[ChromaDB] Reusing healthy existing instance at ${activeChromaUrl}`);
                    resolve(true);
                    return;
                }
            }

            let selectedPort = null;
            for (const p of candidatePorts) {
                const available = await isPortAvailable(host, p);
                if (available) {
                    selectedPort = p;
                    break;
                }
            }

            if (selectedPort == null) {
                console.warn(`[ChromaDB] No free local port found for Chroma startup. Checked: ${candidatePorts.join(', ')}`);
                resolve(false);
                return;
            }

            activeChromaUrl = `${parsed.protocol}//${host}:${selectedPort}`;
            console.log(`[ChromaDB] Using ${activeChromaUrl}`);

            chromaProcess = spawn('chroma', [
                'run', '--host', host, '--port', String(selectedPort), '--path', './chroma_data'
            ], {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Let stdout and stderr passthrough for debugging if needed, but rely on HTTP healthcheck instead
            chromaProcess.stdout.on('data', () => { });
            chromaProcess.stderr.on('data', (data) => {
                const msg = String(data || '').trim();
                if (msg.includes('Address') && msg.includes('not available')) {
                    console.warn('[ChromaDB] Port bind failure detected from Chroma CLI:', msg);
                }
            });

            chromaProcess.on('error', (err) => {
                console.error('[ChromaDB] Failed to spawn chromadb locally.', err.message);
                chromaProcess = null;
                resolve(false);
            });

            chromaProcess.on('close', (code) => {
                if (code !== null) {
                    console.log(`[ChromaDB] Process exited with code ${code}`);
                }
                chromaProcess = null;
                collection = null;
                if (!shuttingDown) {
                    scheduleReconnect(15000);
                }
            });

            const healthy = await waitForChromaHealth();
            if (healthy) {
                console.log('[ChromaDB] Server is running locally and healthy.');
                resolve(true);
                return;
            }

            console.warn('[ChromaDB] Healthcheck timeout. Proceeding, but connection may fail.');
            resolve(false);
        };

        launch();
    });
}

function stopChromaServer() {
    shuttingDown = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    return new Promise((resolve) => {
        if (!chromaProcess) {
            resolve();
            return;
        }

        console.log('[ChromaDB] Shutting down local instance...');
        const proc = chromaProcess;
        const pid = proc.pid;
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            chromaProcess = null;
            resolve();
        };

        proc.once('close', finish);

        try {
            // Kill process group first (works because detached:true)
            process.kill(-pid, 'SIGTERM');
        } catch {
            try { process.kill(pid, 'SIGTERM'); } catch { }
        }

        setTimeout(() => {
            if (done) return;
            try { process.kill(-pid, 'SIGKILL'); } catch {
                try { process.kill(pid, 'SIGKILL'); } catch { }
            }
            finish();
        }, 4000);
    });
}

async function initialize() {
    try {
        const chromaUrl = activeChromaUrl;
        let host = 'localhost';
        let port = 8000;
        let ssl = false;

        try {
            const parsed = new URL(chromaUrl);
            host = parsed.hostname;
            port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
            ssl = parsed.protocol === 'https:';
        } catch (e) {
            // keep defaults
        }

        client = new ChromaClient({ host, port, ssl });
        const embeddingFunction = {
            // We always pass explicit embeddings/queryEmbeddings, so this is a safe fallback.
            generate: async (texts) => new Array(texts.length).fill([])
        };

        const originalWarn = console.warn;
        const suppressMsg = 'No embedding function configuration found for collection schema deserialization';
        console.warn = (...args) => {
            const msg = String(args?.[0] || '');
            if (msg.includes(suppressMsg)) return;
            originalWarn(...args);
        };

        try {
            let retries = 8;
            while (retries > 0) {
                try {
                    try {
                        // Prefer getCollection with embeddingFunction for existing collections.
                        collection = await client.getCollection({
                            name: 'agent_memories',
                            embeddingFunction,
                        });
                    } catch {
                        collection = await client.createCollection({
                            name: 'agent_memories',
                            embeddingFunction,
                        });
                    }
                    break;
                } catch (err) {
                    retries -= 1;
                    if (retries <= 0) throw err;
                    await new Promise((r) => setTimeout(r, 1500));
                }
            }
        } finally {
            console.warn = originalWarn;
        }

        console.log('[ChromaDB] Connected and agent_memories collection ready');
    } catch (err) {
        console.warn(`[ChromaDB] Warning: Could not connect to ChromaDB at ${activeChromaUrl}. RAG memory will be disabled for now. Error: ${err.message}`);
        collection = null;
        scheduleReconnect(15000);
    }
}

async function generateEmbedding(text) {
    if (!text) return null;
    const input = String(text || '');
    try {
        const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        try {
            const response = await axios.post(`${baseUrl}/api/embeddings`, {
                model: 'nomic-embed-text',
                prompt: input
            });
            return response.data.embedding;
        } catch (err) {
            if (err?.response?.status !== 404) throw err;
            const fallback = await axios.post(`${baseUrl}/api/embed`, {
                model: 'nomic-embed-text',
                input,
            });
            const emb = fallback?.data?.embeddings?.[0] || fallback?.data?.embedding || null;
            return emb;
        }
    } catch (err) {
        console.warn(`[Ollama Embeddings] Failed to generate embedding: ${err.message}`);
        return null;
    }
}

async function saveMemory(agentId, taskGoal, fullOutput, memoryId) {
    if (!collection) return; // Silent return if Chroma is offline
    try {
        const textToEmbed = `${taskGoal} ${fullOutput.substring(0, 500)}`;
        const embedding = await generateEmbedding(textToEmbed);

        if (!embedding) return;

        await collection.add({
            ids: [memoryId.toString()],
            embeddings: [embedding],
            documents: [fullOutput],
            metadatas: [{
                agentId: agentId.toString(),
                taskGoal: taskGoal,
                timestamp: new Date().toISOString()
            }]
        });
        console.log(`[ChromaDB] Saved memory for agent ${agentId}`);
    } catch (err) {
        console.error(`[ChromaDB] Save error for agent ${agentId}:`, err.message);
    }
}

async function retrieveRelevant(agentId, queryText, limit = 2) {
    if (!collection || !queryText) return [];
    try {
        const queryEmbedding = await generateEmbedding(queryText);

        if (!queryEmbedding) return [];

        const results = await collection.query({
            queryEmbeddings: [queryEmbedding],
            nResults: limit,
            where: { agentId: agentId.toString() }
        });

        const relevantMemories = [];
        // Chroma returns 2D arrays: [batch][result]
        if (results.distances && results.distances[0]) {
            for (let i = 0; i < results.distances[0].length; i++) {
                const distance = results.distances[0][i];
                // Distance threshold
                if (distance < 0.75) {
                    relevantMemories.push({
                        pastGoal: results.metadatas[0][i].taskGoal,
                        relevantOutput: results.documents[0][i]
                    });
                }
            }
        }

        return relevantMemories;
    } catch (err) {
        console.error(`[ChromaDB] Retrieval error for agent ${agentId}:`, err.message);
        return [];
    }
}

module.exports = {
    startChromaServer,
    stopChromaServer,
    initialize,
    generateEmbedding,
    saveMemory,
    retrieveRelevant
};
