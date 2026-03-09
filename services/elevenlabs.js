const axios = require('axios');

// Log the key-invalid warning only once per server session
let _keyWarned = false;

// Maps LibreTranslate/App language codes to ElevenLabs language_code
const ELEVENLABS_LANGUAGES = {
    en: 'en',
    hi: 'hi',
    bn: 'bn',
    fr: 'fr',
    es: 'es',
    de: 'de',
    zh: 'zh',
    ja: 'ja',
    ar: 'ar'
};

async function textToSpeech(text, language = 'en') {
    const rawKey = process.env.ELEVENLABS_API_KEY;
    const apiKey = rawKey ? rawKey.trim() : null;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    if (!apiKey || apiKey === 'your_key_here') {
        console.warn('[ElevenLabs] No API key set. Falling back to Web Speech Synthesis.');
        return null;
    }

    try {
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            data: {
                text: text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            },
            responseType: 'arraybuffer',
            timeout: 15000
        });

        return Buffer.from(response.data);
    } catch (error) {
        let errorDataStr = 'No data';
        if (error.response && error.response.data) {
            try {
                errorDataStr = Buffer.from(error.response.data).toString('utf8');
            } catch (e) {
                errorDataStr = 'Could not parse buffer to string';
            }
        }

        console.log(`[ElevenLabs Error] Status: ${error.response ? error.response.status : 'No Status'}`);
        console.log(`[ElevenLabs Error Data] ${errorDataStr}`);
        console.log(`[ElevenLabs Message] ${error.message}`);
        return null;
    }
}

module.exports = { textToSpeech };
