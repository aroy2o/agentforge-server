const express = require('express');
const router = express.Router();
const { textToSpeech } = require('../services/elevenlabs');
const { parseVoiceCommand } = require('../services/voiceCommandParser');

// POST /api/voice/command
// Accepts { transcript } and returns a structured command object parsed by Ollama.
router.post('/command', async (req, res) => {
    try {
        const { transcript, conversationHistory = [] } = req.body;
        if (!transcript || typeof transcript !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid transcript' });
        }

        const command = await parseVoiceCommand(transcript.trim(), conversationHistory);
        res.json(command);
    } catch (error) {
        console.error('[Voice Command Route Error]', error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/voice/speak
router.post('/speak', async (req, res) => {
    try {
        const { text, language } = req.body;

        // 1. Primary Engine: ElevenLabs
        const elevenBuffer = await textToSpeech(text, language);
        if (elevenBuffer && elevenBuffer.length > 0) {
            res.set('Content-Type', 'audio/mpeg');
            res.set('Content-Length', Number(elevenBuffer.length));
            res.set('X-Voice-Engine', 'elevenlabs');
            res.set('Cache-Control', 'no-cache');
            res.end(elevenBuffer);
            return;
        }

        // 2. Absolute Fallback (Trigger Browser speechSynthesis)
        console.log('[Route Diagnostics] ElevenLabs failed. Sending 204 for Browser Fallback.');
        res.status(204).end();
    } catch (error) {
        console.error('[Voice Route Error]', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
