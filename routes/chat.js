const express = require('express');
const router = express.Router();
const queries = require('../database/queries');
const { optionalAuth } = require('../middleware/auth');

router.use(optionalAuth);

// Get a safe identifier for the user (authenticated ID or a guest string if allowed)
const getUserId = (req) => {
    return req.user ? req.user.userId : (req.headers['x-guest-id'] || 'guest');
};

// GET /api/chat — Get all sessions for the current user
router.get('/', async (req, res) => {
    try {
        const userId = getUserId(req);
        const sessions = await queries.getSessionsByUser(userId);
        res.json({ sessions });
    } catch (error) {
        console.error('[Chat GET All Error]', error);
        res.status(500).json({ error: 'Failed to fetch sessions.' });
    }
});

// POST /api/chat — Create a new session
router.post('/', async (req, res) => {
    try {
        const userId = getUserId(req);
        const { title, taskGoal, pipelineAgents } = req.body;

        // Auto-title from taskGoal if title is not explicitly provided
        let autoTitle = title;
        if (!autoTitle) {
            autoTitle = taskGoal ? taskGoal.substring(0, 50) + (taskGoal.length > 50 ? '...' : '') : 'New Session';
        }

        const session = await queries.createSession(userId, autoTitle, taskGoal, pipelineAgents);
        res.status(201).json({ session, sessionId: session.sessionId });
    } catch (error) {
        console.error('[Chat POST Error]', error);
        res.status(500).json({ error: 'Failed to create session.' });
    }
});

// GET /api/chat/:sessionId — Get a specific full session
router.get('/:sessionId', async (req, res) => {
    try {
        const userId = getUserId(req);
        const session = await queries.getSessionById(req.params.sessionId, userId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        res.json({ session });
    } catch (error) {
        console.error('[Chat GET One Error]', error);
        res.status(500).json({ error: 'Failed to fetch session.' });
    }
});

// DELETE /api/chat/:sessionId — Delete a session
router.delete('/:sessionId', async (req, res) => {
    try {
        const userId = getUserId(req);
        const result = await queries.deleteSession(req.params.sessionId, userId);
        if (result.deletedCount === 0) return res.status(404).json({ error: 'Session not found or forbidden' });
        res.json({ success: true });
    } catch (error) {
        console.error('[Chat DELETE Error]', error);
        res.status(500).json({ error: 'Failed to delete session.' });
    }
});

// POST /api/chat/:sessionId/messages — Add a message to a session
router.post('/:sessionId/messages', async (req, res) => {
    try {
        const userId = getUserId(req);
        // Verify ownership first
        const existing = await queries.getSessionById(req.params.sessionId, userId);
        if (!existing) return res.status(404).json({ error: 'Session not found' });

        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message object is required' });

        // Generate ID for message if missing
        if (!message.id) message.id = Date.now().toString() + Math.random().toString(36).substring(2);

        const updatedSession = await queries.addMessage(req.params.sessionId, message);
        res.json({ session: updatedSession });
    } catch (error) {
        console.error('[Chat Add Message Error]', error);
        res.status(500).json({ error: 'Failed to add message.' });
    }
});

// PUT /api/chat/:sessionId/title — Update a session's title
router.put('/:sessionId/title', async (req, res) => {
    try {
        const userId = getUserId(req);
        // Verify ownership
        const existing = await queries.getSessionById(req.params.sessionId, userId);
        if (!existing) return res.status(404).json({ error: 'Session not found' });

        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'Title is required' });

        const updatedSession = await queries.updateSessionTitle(req.params.sessionId, title.trim());
        res.json({ session: updatedSession });
    } catch (error) {
        console.error('[Chat PUT Title Error]', error);
        res.status(500).json({ error: 'Failed to update title.' });
    }
});

// POST /api/chat/stream — Direct LLM streaming chat (ChatGPT-style)
router.post('/stream', async (req, res) => {
    try {
        const { messages = [], systemPrompt } = req.body;

        if (!messages || messages.length === 0) {
            return res.status(400).json({ error: 'Messages array is required.' });
        }

        const { streamOllama } = require('../services/ollama');

        const sysPrompt = systemPrompt ||
            `You are ARIA, an intelligent AI assistant inside AgentForge — an advanced multi-agent AI platform. 
You help users think through complex problems, answer questions, explain concepts, and brainstorm ideas.
Be concise but thorough. Use markdown formatting where helpful. Be conversational and professional.`;

        // Build an Ollama-compatible messages array from conversation history
        const ollamaMessages = messages.map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
        }));

        // Last message is the current user input
        const latestUserMessage = ollamaMessages[ollamaMessages.length - 1]?.content || '';

        const ollamaStreamResponse = await streamOllama({
            systemPrompt: sysPrompt,
            userMessage: latestUserMessage,
            // Pass prior conversation as context in system prompt if multi-turn
            ...(ollamaMessages.length > 1 ? {
                systemPrompt: sysPrompt + '\n\nCONVERSATION HISTORY:\n' +
                    ollamaMessages.slice(0, -1).map(m => `${m.role === 'assistant' ? 'ARIA' : 'User'}: ${m.content}`).join('\n\n')
            } : {})
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        ollamaStreamResponse.data.on('data', (chunk) => {
            const lines = chunk.toString('utf8').split('\n').filter(l => l.trim() !== '');
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    const tokenData = {
                        token: parsed.message ? parsed.message.content : '',
                        done: parsed.done
                    };
                    res.write(`data: ${JSON.stringify(tokenData)}\n\n`);
                    if (parsed.done) {
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                } catch (e) {
                    // ignore parse errors on partial chunks
                }
            }
        });

        ollamaStreamResponse.data.on('end', () => res.end());
        ollamaStreamResponse.data.on('error', (err) => {
            console.error('[Chat Stream Error]', err);
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
        });

    } catch (error) {
        console.error('[Chat Stream Route Error]', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
