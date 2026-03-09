const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');

let cachedLanguages = null;

// Language proxy map: translate via a nearby language when the exact one isn't available.
// Assamese uses Bengali script and is closely related — LibreTranslate with 'bn' produces
// readable Bengali-script output that Assamese speakers can read.
const LANGUAGE_PROXY = {
    'as': 'bn',  // Assamese → Bengali (same script, close family)
    'or': 'bn',  // Odia is often proxied via Bengali in minimal setups
};

const translate = async (text, targetLanguage, sourceLanguage = "en") => {
    try {
        const url = process.env.LIBRETRANSLATE_URL || 'http://localhost:5000';

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
        const url = process.env.LIBRETRANSLATE_URL || 'http://localhost:5000';
        const response = await axios.get(`${url}/languages`);

        // Cache the parsed response which is an array of objects
        cachedLanguages = response.data;
        return cachedLanguages;
    } catch (error) {
        console.error("Failed to fetch languages:", error.message);
        return [];
    }
};

module.exports = {
    translate,
    getSupportedLanguages
};
