const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_LT_URL = `http://${process.env.LIBRETRANSLATE_HOST || '127.0.0.1'}:${process.env.LIBRETRANSLATE_PORT || '8002'}`;

let cachedLanguages = null;
let lastLanguageFetchErrorAt = 0;
const LANGUAGE_ERROR_LOG_COOLDOWN_MS = 30000;

const FALLBACK_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'hi', name: 'Hindi' },
    { code: 'bn', name: 'Bengali' },
    { code: 'ta', name: 'Tamil' },
    { code: 'te', name: 'Telugu' },
    { code: 'mr', name: 'Marathi' },
    { code: 'gu', name: 'Gujarati' },
    { code: 'kn', name: 'Kannada' },
    { code: 'pa', name: 'Punjabi' },
    { code: 'fr', name: 'French' },
    { code: 'es', name: 'Spanish' },
    { code: 'de', name: 'German' },
];

// Language proxy map: translate via a nearby language when the exact one isn't available.
// Assamese uses Bengali script and is closely related — LibreTranslate with 'bn' produces
// readable Bengali-script output that Assamese speakers can read.
const LANGUAGE_PROXY = {
    'as': 'bn',  // Assamese → Bengali (same script, close family)
    'or': 'bn',  // Odia is often proxied via Bengali in minimal setups
};

const translate = async (text, targetLanguage, sourceLanguage = "en") => {
    try {
        const url = process.env.LIBRETRANSLATE_URL || DEFAULT_LT_URL;

        // Map to a supported proxy language if needed
        const effectiveLang = LANGUAGE_PROXY[targetLanguage] || targetLanguage;

        // Try Local LibreTranslate first (longer timeout to handle model warmup)
        try {
            const response = await axios.post(`${url}/translate`, {
                q: text,
                source: sourceLanguage,
                target: effectiveLang,
                format: "text"
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 8000
            });

            if (response.data && response.data.translatedText) {
                return response.data.translatedText;
            }
        } catch (localErr) {
            console.error(`LibreTranslate failed for [${effectiveLang}]: ${localErr.message}`);
        }

        // Cloud Failover (Google GTX Free Tier) — best-effort, may be blocked in some networks
        try {
            const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLanguage === 'en' ? 'en' : 'auto'}&tl=${effectiveLang}&dt=t&q=${encodeURIComponent(text)}`;
            const gtxResponse = await axios.get(gtxUrl, { timeout: 6000 });
            if (gtxResponse.data && gtxResponse.data[0]) {
                return gtxResponse.data[0].map(part => part[0]).join('');
            }
        } catch (fallbackError) {
            // Silently ignore — network may be restricted
        }

        // Absolute fallback: return the original text so the app never breaks
        return text;
    } catch (error) {
        console.error("Translation outer error:", error.message);
        return text;
    }
};

const getSupportedLanguages = async () => {
    if (cachedLanguages) {
        return cachedLanguages;
    }

    try {
        const url = process.env.LIBRETRANSLATE_URL || DEFAULT_LT_URL;
        const response = await axios.get(`${url}/languages`, { timeout: 2500 });

        // Cache the parsed response which is an array of objects
        if (Array.isArray(response.data) && response.data.length > 0) {
            cachedLanguages = response.data;
            return cachedLanguages;
        }

        cachedLanguages = FALLBACK_LANGUAGES;
        return cachedLanguages;
    } catch (error) {
        const now = Date.now();
        if (now - lastLanguageFetchErrorAt > LANGUAGE_ERROR_LOG_COOLDOWN_MS) {
            lastLanguageFetchErrorAt = now;
            console.warn('[Translator] Language endpoint unavailable, using fallback language list.');
        }
        cachedLanguages = FALLBACK_LANGUAGES;
        return cachedLanguages;
    }
};

module.exports = {
    translate,
    getSupportedLanguages
};
