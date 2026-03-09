const { ChromaClient } = require('chromadb');
const axios = require('axios');
const { spawn } = require('child_process');

let client = null;
let collection = null;
let chromaProcess = null;

function startChromaServer() {
    return new Promise((resolve) => {
        console.log('[ChromaDB] Spawning local instance...');

        chromaProcess = spawn('chroma', [
            'run', '--host', 'localhost', '--port', '8000', '--path', './chroma_data'
        ], {
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Let stdout and stderr passthrough for debugging if needed, but rely on HTTP healthcheck instead
        chromaProcess.stdout.on('data', () => { });
        chromaProcess.stderr.on('data', () => { });

        chromaProcess.on('error', (err) => {
            console.error('[ChromaDB] Failed to spawn chromadb locally.', err.message);
            resolve(false);
        });

        chromaProcess.on('close', (code) => {
            if (code !== null) {
                console.log(`[ChromaDB] Process exited with code ${code}`);
            }
        });

        let isResolved = false;

        const checkHealth = async () => {
            if (isResolved) return;
            try {
                // Chroma's /api/v2/heartbeat endpoint
                const res = await axios.get('http://localhost:8000/api/v2/heartbeat', { timeout: 1000 });
                if (res.status === 200 && !isResolved) {
                    isResolved = true;
                    console.log('[ChromaDB] Server is running locally and healthy.');
                    resolve(true);
                }
            } catch (e) {
                if (!isResolved) {
                    setTimeout(checkHealth, 1000);
                }
            }
        };

        // Start polling after 1.5 seconds
        setTimeout(checkHealth, 1500);

        // Ultimate fallback if it doesn't return healthy after 15 seconds
        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                console.warn('[ChromaDB] Healthcheck timeout after 15s. Proceeding, but connection may fail.');
                resolve(false);
            }
        }, 15000);
    });
}

function stopChromaServer() {
    if (chromaProcess) {
        console.log('[ChromaDB] Shutting down local instance...');
        chromaProcess.kill('SIGTERM');
        chromaProcess = null;
    }
}

async function initialize() {
    try {
        const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';
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
        collection = await client.getOrCreateCollection({
            name: 'agent_memories',
            // DefaultEmbeddingFunction fallback if @chroma-core/default-embed is missing
            embeddingFunction: {
                generate: async (texts) => new Array(texts.length).fill([])
            }
        });
        console.log('[ChromaDB] Connected and agent_memories collection ready');
    } catch (err) {
        console.warn(`[ChromaDB] Warning: Could not connect to ChromaDB at ${process.env.CHROMA_URL}. RAG memory will be disabled. Error: ${err.message}`);
        collection = null;
    }
}

async function generateEmbedding(text) {
    if (!text) return null;
    try {
        const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        const response = await axios.post(`${baseUrl}/api/embeddings`, {
            model: 'nomic-embed-text',
            prompt: text
        });
        return response.data.embedding;
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
