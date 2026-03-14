const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { searchWeb } = require('../services/tavily');
const { callOllama } = require('../services/ollama');
const { translate, getSupportedLanguages } = require('../services/translator');
const cronParser = require('cron-parser');
const axios = require('axios');
const transporter = require('../services/mailer');
const User = require('../database/models/User');
const { createPermissionRequest } = require('../services/emailPermissionService');
const pdfParse = require('pdf-parse');
const vm = require('vm');
const { spawn } = require('child_process');

const FX_CACHE_TTL_MS = 60 * 60 * 1000;
const fxRateCache = {};

function isEmailDeliveryEnabled(user) {
    return Boolean(user?.notifications?.emailEnabled);
}

function normalizeBase64Input(raw) {
    const text = String(raw || '').trim();
    return String(text.split(',').pop() || '').replace(/\s+/g, '');
}

function pickVisionModel(models = []) {
    const normalized = models.map((m) => ({
        name: String(m?.name || '').trim(),
        lower: String(m?.name || '').toLowerCase(),
        families: Array.isArray(m?.details?.families)
            ? m.details.families.map((f) => String(f || '').toLowerCase())
            : [],
    }));

    // Step 1: Prefer canonical llava models first.
    const llava = normalized.find((m) => m.lower.includes('llava') && !m.lower.includes('bakllava'));
    if (llava) return { modelName: llava.name, source: 'llava' };

    // Step 2: Fallback vision family chain.
    const altVision = normalized.find((m) =>
        ['bakllava', 'moondream', 'cogvlm'].some((k) => m.lower.includes(k))
    );
    if (altVision) return { modelName: altVision.name, source: 'fallback-vision' };

    // Last-resort compatibility for other explicit vision families.
    const compatibleVision = normalized.find((m) => m.families.includes('clip') || m.families.includes('vision'));
    if (compatibleVision) return { modelName: compatibleVision.name, source: 'fallback-compat' };

    return null;
}

function getNextRunAtFromCron(cronExpression) {
    try {
        const expr = cronParser.CronExpressionParser.parse(cronExpression);
        const next = expr.next();
        const date = next?.toDate ? next.toDate() : new Date(next);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
        return null;
    }
}

function to12HourLabel(hour24, minute) {
    const suffix = hour24 >= 12 ? 'PM' : 'AM';
    const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const mm = String(minute).padStart(2, '0');
    return `${h12}:${mm} ${suffix}`;
}

function extractTimeParts(input) {
    const t = String(input || '').toLowerCase();
    const match = t.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!match) {
        return { hour: 9, minute: 0, found: false };
    }

    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const ampm = match[3] ? match[3].toLowerCase() : null;

    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (!ampm && hour === 24) hour = 0;

    hour = Math.max(0, Math.min(23, hour));
    const clampedMinute = Math.max(0, Math.min(59, minute));

    return { hour, minute: clampedMinute, found: true };
}

function tryLocalParse(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const t = raw.toLowerCase();
    let { hour, minute, found } = extractTimeParts(raw);

    if (!found) {
        if (/\bmidnight\b/.test(t)) {
            hour = 0;
            minute = 0;
        } else if (/\b(noon|midday)\b/.test(t)) {
            hour = 12;
            minute = 0;
        } else if (/\b(night|tonight)\b/.test(t)) {
            hour = 21;
            minute = 0;
        } else if (/\bevening\b/.test(t)) {
            hour = 18;
            minute = 0;
        } else if (/\bafternoon\b/.test(t)) {
            hour = 14;
            minute = 0;
        } else if (/\bmorning\b/.test(t)) {
            hour = 9;
            minute = 0;
        }
    }
    const timeLabel = to12HourLabel(hour, minute);
    const dayMap = {
        sunday: 0,
        monday: 1,
        tuesday: 2,
        wednesday: 3,
        thursday: 4,
        friday: 5,
        saturday: 6,
    };

    // 0) daily (with optional time)
    if (/^daily\b/.test(t) || /\bevery\s+day\b/.test(t)) {
        const cronExpression = `${minute} ${hour} * * *`;
        return {
            cronExpression,
            humanReadable: `Every day at ${timeLabel}`,
            nextRunAt: getNextRunAtFromCron(cronExpression),
            confidence: 1,
            clarification: null,
        };
    }

    // 0.25) every morning/afternoon/evening/night/noon/midnight with optional explicit time
    const periodDefaults = [
        { key: 'morning', hour: 9 },
        { key: 'afternoon', hour: 14 },
        { key: 'evening', hour: 18 },
        { key: 'night', hour: 21 },
        { key: 'tonight', hour: 21 },
        { key: 'noon', hour: 12 },
        { key: 'midday', hour: 12 },
        { key: 'midnight', hour: 0 },
    ];

    for (const period of periodDefaults) {
        if (new RegExp(`\\bevery\\s+${period.key}\\b`).test(t) || new RegExp(`\\b${period.key}\\b`).test(t)) {
            const periodHour = found ? hour : period.hour;
            const periodMinute = found ? minute : 0;
            const periodLabel = to12HourLabel(periodHour, periodMinute);
            const cronExpression = `${periodMinute} ${periodHour} * * *`;
            return {
                cronExpression,
                humanReadable: `Every day at ${periodLabel}`,
                nextRunAt: getNextRunAtFromCron(cronExpression),
                confidence: 1,
                clarification: null,
            };
        }
    }

    // 0.5) every [weekday] (with optional time)
    const dayMatch = t.match(/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (dayMatch) {
        const dayName = dayMatch[1];
        const dayNumber = dayMap[dayName];
        const cronExpression = `${minute} ${hour} * * ${dayNumber}`;
        const dayLabel = dayName.charAt(0).toUpperCase() + dayName.slice(1);
        return {
            cronExpression,
            humanReadable: `Every ${dayLabel} at ${timeLabel}`,
            nextRunAt: getNextRunAtFromCron(cronExpression),
            confidence: 1,
            clarification: null,
        };
    }

    // 1) every alternative/alternate/other day (with optional time, preserves time if present)
    if (/every\s+(alternative|alternate|other)\s+day/.test(t)) {
        return {
            cronExpression: `${minute} ${hour} */2 * *`,
            humanReadable: `Every 2 days at ${timeLabel}`,
            nextRunAt: getNextRunAtFromCron(`${minute} ${hour} */2 * *`),
            confidence: 1,
            clarification: null,
        };
    }

    // 2) every N days
    const everyNDays = t.match(/every\s+(\d+)\s+days?/);
    if (everyNDays) {
        const n = Number(everyNDays[1]);
        if (Number.isFinite(n) && n > 0) {
            const cronExpression = `${minute} ${hour} */${n} * *`;
            return {
                cronExpression,
                humanReadable: found
                    ? `Every ${n} days at ${timeLabel}`
                    : `Every ${n} days`,
                nextRunAt: getNextRunAtFromCron(cronExpression),
                confidence: 1,
                clarification: null,
            };
        }
    }

    // 3) every N hours
    const everyNHours = t.match(/every\s+(\d+)\s+hours?/);
    if (everyNHours) {
        const n = Number(everyNHours[1]);
        if (Number.isFinite(n) && n > 0) {
            const cronExpression = `0 */${n} * * *`;
            return {
                cronExpression,
                humanReadable: `Every ${n} hours`,
                nextRunAt: getNextRunAtFromCron(cronExpression),
                confidence: 1,
                clarification: null,
            };
        }
    }

    // 4) every N minutes
    const everyNMinutes = t.match(/every\s+(\d+)\s+minutes?/);
    if (everyNMinutes) {
        const n = Number(everyNMinutes[1]);
        if (Number.isFinite(n) && n > 0) {
            const cronExpression = `*/${n} * * * *`;
            return {
                cronExpression,
                humanReadable: `Every ${n} minutes`,
                nextRunAt: getNextRunAtFromCron(cronExpression),
                confidence: 1,
                clarification: null,
            };
        }
    }

    // 5) twice a week
    if (/twice\s+a\s+week/.test(t)) {
        const cronExpression = '0 9 * * 1,4';
        return {
            cronExpression,
            humanReadable: 'Twice a week',
            nextRunAt: getNextRunAtFromCron(cronExpression),
            confidence: 1,
            clarification: null,
        };
    }

    // 6) every weekend/saturday/sunday
    if (/every\s+(weekend|saturday|sunday)/.test(t)) {
        const cronExpression = '0 9 * * 6,0';
        return {
            cronExpression,
            humanReadable: 'Every weekend',
            nextRunAt: getNextRunAtFromCron(cronExpression),
            confidence: 1,
            clarification: null,
        };
    }

    // 7) every weekday with optional time
    if (/every\s+weekday/.test(t)) {
        const cronExpression = `${minute} ${hour} * * 1-5`;
        return {
            cronExpression,
            humanReadable: `Every weekday at ${timeLabel}`,
            nextRunAt: getNextRunAtFromCron(cronExpression),
            confidence: 1,
            clarification: null,
        };
    }

    return null;
}

function decodeBase64ToBuffer(base64Input) {
    const raw = String(base64Input || '').trim();
    const cleaned = (raw.includes(',') ? raw.split(',').pop() : raw).replace(/\s+/g, '');
    return Buffer.from(cleaned, 'base64');
}

async function extractPdfText(pdfBuffer) {
    // pdf-parse v2 exports PDFParse class; older versions export a callable function.
    if (pdfParse && typeof pdfParse.PDFParse === 'function') {
        const parser = new pdfParse.PDFParse({ data: pdfBuffer });
        try {
            const textResult = await parser.getText();
            return {
                text: String(textResult?.text || ''),
                numpages: Number(textResult?.total || 0),
            };
        } finally {
            await parser.destroy().catch(() => undefined);
        }
    }

    if (typeof pdfParse === 'function') {
        return pdfParse(pdfBuffer);
    }

    throw new Error('Unsupported pdf-parse export shape');
}

async function fetchBufferFromUrl(url) {
    const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 20 * 1024 * 1024,
    });
    return Buffer.from(resp.data);
}

function hasUnsafeExecutionPattern(source) {
    const s = String(source || '').toLowerCase();
    const blockedPatterns = [
        /\brequire\s*\(\s*['"](fs|net|http|https|tls|child_process|dgram|dns|os|cluster)['"]\s*\)/,
        /\bimport\s+.*\b(fs|net|http|https|child_process)\b/,
        /\b(open|write|unlink|remove|mkdir|rmdir|chmod|chown)\b/,
        /\b(fetch|axios|curl|wget|requests|urllib|socket)\b/,
        /\bsubprocess\b/,
        /\bos\.system\b/,
        /\bexec\b/,
        />|>>|\brm\s+-rf\b/,
    ];
    return blockedPatterns.some((p) => p.test(s));
}

function toChartDatasetColor(type) {
    if (type === 'line') return '#06b6d4';
    if (type === 'pie') return ['#06b6d4', '#f59e0b', '#a78bfa', '#34d399', '#f43f5e', '#6366f1'];
    if (type === 'doughnut') return ['#f97316', '#06b6d4', '#a78bfa', '#34d399', '#f59e0b', '#ef4444'];
    return '#3b82f6';
}

router.post('/parse-time', async (req, res) => {
    try {
        const { input } = req.body || {};
        if (!input || typeof input !== 'string' || !input.trim()) {
            return res.status(400).json({ error: 'parse_failed' });
        }

        const localParsed = tryLocalParse(input);
        if (localParsed) {
            return res.json(localParsed);
        }

        const systemPrompt = `You are a cron expression generator. The user will give you a time description in any format. You must return a JSON object with exactly these fields and nothing else — no explanation, no markdown, no extra text:

    cronExpression — a valid 5-part cron string
    humanReadable — a plain English description like "Every day at 10:30 AM"
    nextRunAt — the next occurrence as an ISO 8601 datetime string computed from now
    confidence — a number from 0 to 1 indicating how certain you are
    clarification — null if confident, or a short question to ask the user if the input is ambiguous

    Use these rules without exception:

    "daily at 10:30am" → 30 10 * * *
    "every day at 6pm" → 0 18 * * *
    "every monday at 9am" → 0 9 * * 1
    "every weekday at 8am" → 0 8 * * 1-5
    "every hour" → 0 * * * *
    "every 30 minutes" → */30 * * * *
    "every sunday at midnight" → 0 0 * * 0
    "twice a day at 9am and 6pm" → 0 9,18 * * *
    "first of every month at 10am" → 0 10 1 * *
    "every alternative day" → 0 9 */2 * *, human readable: "Every 2 days at 9:00 AM"
    "every other day" → 0 9 */2 * *, human readable: "Every 2 days"
    "every 2 days" → 0 9 */2 * *, human readable: "Every 2 days"
    "every 3 days" → 0 9 */3 * *, human readable: "Every 3 days"
    "every alternate day" → 0 9 */2 * *, human readable: "Every 2 days"
    "every other week" → 0 9 * * 1/2, human readable: "Every 2 weeks"
    "every 2 weeks" → 0 9 */14 * *, human readable: "Every 2 weeks"
    "every alternative week" → 0 9 */14 * *, human readable: "Every 2 weeks"
    "every third day" → 0 9 */3 * *, human readable: "Every 3 days"
    "every 6 hours" → 0 */6 * * *, human readable: "Every 6 hours"
    "every 2 hours" → 0 */2 * * *, human readable: "Every 2 hours"
    "every 15 minutes" → */15 * * * *, human readable: "Every 15 minutes"
    "twice a week" → 0 9 * * 1,4, human readable: "Twice a week (Mon & Thu)"
    "three times a week" → 0 9 * * 1,3,5, human readable: "Three times a week (Mon, Wed, Fri)"
    "every weeknight" → 0 21 * * 1-5, human readable: "Every weeknight at 9:00 PM"
    "every weekend" → 0 9 * * 6,0, human readable: "Every weekend"
    Times like "10:30 am", "10:30AM", "10.30am", "half past ten" must all resolve to 30 10 * * *
    The word "alternative" always means interval of 2. The word "alternate" always means interval of 2. The phrase "every other" always means interval of 2. Never map these to "every day" or "every week" - they require the step syntax such as */2. When you see an interval pattern and a specific time, preserve the time in the cron expression. For example "every alternative day at 10:30am" → 30 10 */2 * * not 0 9 */2 * *.
    If the user says "daily" with no time assume 9:00 AM → 0 9 * * *
    When the user says morning with no specific time use 9:00 AM.
    When the user says afternoon use 2:00 PM.
    When the user says evening use 6:00 PM.
    If the input is completely unparseable set confidence below 0.5 and set clarification to ask what time they meant`;

        const raw = await callOllama({
            systemPrompt,
            userMessage: input,
            stream: false,
            options: { temperature: 0.1, num_predict: 200 },
        });

        const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return res.status(500).json({ error: 'parse_failed' });
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const cronExpression = String(parsed.cronExpression || '').trim();
        const humanReadable = String(parsed.humanReadable || '').trim();
        const confidence = Number(parsed.confidence);
        const clarification = parsed.clarification == null ? null : String(parsed.clarification).trim();

        let nextRunAt = parsed.nextRunAt ? new Date(parsed.nextRunAt) : null;
        if (!nextRunAt || Number.isNaN(nextRunAt.getTime())) {
            const fallback = getNextRunAtFromCron(cronExpression);
            nextRunAt = fallback ? new Date(fallback) : null;
        }

        if (!cronExpression || !humanReadable || Number.isNaN(confidence)) {
            return res.status(500).json({ error: 'parse_failed' });
        }

        return res.json({
            cronExpression,
            humanReadable,
            nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
            confidence,
            clarification,
        });
    } catch (error) {
        return res.status(500).json({ error: 'parse_failed' });
    }
});

router.post('/pdf-reader', requireAuth, async (req, res) => {
    try {
        const { fileUrl, base64 } = req.body || {};
        let pdfBuffer = null;

        if (typeof base64 === 'string' && base64.trim()) {
            pdfBuffer = decodeBase64ToBuffer(base64);
        } else if (fileUrl) {
            pdfBuffer = await fetchBufferFromUrl(fileUrl);
        }

        if (!pdfBuffer) {
            return res.status(400).json({ success: false, error: 'Could not extract PDF content' });
        }

        const data = await extractPdfText(pdfBuffer);
        const rawText = String(data?.text || '').trim();
        if (!rawText) {
            return res.json({ success: false, error: 'PDF has no extractable text — it may be a scanned image PDF' });
        }

        let extractedText = rawText;
        if (extractedText.length > 15000) {
            extractedText = `${extractedText.slice(0, 15000)}... [content truncated to fit context window]`;
        }

        const wordCount = extractedText.split(/\s+/).filter(Boolean).length;
        return res.json({
            success: true,
            content: extractedText,
            pageCount: Number(data?.numpages || 0),
            wordCount,
        });
    } catch {
        return res.json({ success: false, error: 'Could not extract PDF content' });
    }
});

// DISABLED — re-enable when ready to implement
/* router.post('/image-analyzer', requireAuth, async (req, res) => {
    try {
        console.log('IMAGE ANALYZER HIT');
        const { imageUrl, base64, imageName, width, height, filesizeKb } = req.body || {};
        let imageBase64 = base64 ? String(base64).trim() : '';
        if (!imageBase64 && imageUrl) {
            const imageBuffer = await fetchBufferFromUrl(imageUrl);
            imageBase64 = imageBuffer.toString('base64');
        }

        console.log(`BASE64 LENGTH: ${String(imageBase64 || '').length}`);

        const ollamaBase = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        const tagsResp = await axios.get(`${ollamaBase}/api/tags`, { timeout: 10000 });
        const models = Array.isArray(tagsResp.data?.models) ? tagsResp.data.models : [];
        console.log(`AVAILABLE MODELS: ${models.map((m) => String(m?.name || '')).filter(Boolean).join(', ')}`);
        if (!imageBase64) {
            return res.status(400).json({ success: false, error: 'Image payload is missing' });
        }

        const cleanBase64 = normalizeBase64Input(imageBase64);
        console.log(`STRIPPED BASE64 PREVIEW: ${cleanBase64.slice(0, 50)}`);
        const prompt = 'Describe everything you see in this image in detail. Read all visible text exactly as written. Identify logos, brand names, colors, icons, and layout. Do not guess or assume anything not visible.';
        const installedModelNames = models.map((m) => String(m?.name || '').trim()).filter(Boolean);
        const lowerInstalled = installedModelNames.map((n) => n.toLowerCase());

        const moondreamModel = installedModelNames[lowerInstalled.findIndex((n) => n.includes('moondream'))] || null;
        const llava7bModel = installedModelNames[lowerInstalled.findIndex((n) => n.includes('llava:7b-v1.6-q4'))] || null;
        const llavaModel = installedModelNames[lowerInstalled.findIndex((n) => n.includes('llava'))] || null;

        const visionModels = [
            moondreamModel ? { modelName: moondreamModel, timeoutMs: 120000 } : null,
            llava7bModel ? { modelName: llava7bModel, timeoutMs: 240000 } : null,
            llavaModel ? { modelName: llavaModel, timeoutMs: 300000 } : null,
        ]
            .filter(Boolean)
            .filter((entry, idx, arr) => arr.findIndex((x) => x.modelName === entry.modelName) === idx);

        if (visionModels.length === 0) {
            return res.json({ success: false, error: 'All vision models failed — check ollama logs' });
        }

        console.log(`SELECTED MODEL: ${visionModels.map((m) => m.modelName).join(' -> ')}`);
        console.log(`OLLAMA REQUEST IMAGES FIELD LENGTH: ${Array.isArray([cleanBase64]) ? [cleanBase64].length : 0}`);

        const tryVisionModel = async (modelName, imageBase64Data, timeoutMs) => {
            const resp = await axios.post(`${ollamaBase}/api/generate`, {
                model: modelName,
                prompt,
                images: [imageBase64Data],
                stream: false,
                options: {
                    num_gpu: 0,
                    num_thread: 8,
                },
            }, { timeout: timeoutMs });

            const text = String(resp.data?.response || '').trim();
            if (!text) throw new Error('Vision model returned empty output');
            return text;
        };

        for (const entry of visionModels) {
            try {
                const visionText = await tryVisionModel(entry.modelName, cleanBase64, entry.timeoutMs);
                console.log(`VISION SUCCESS with ${entry.modelName}`);
                console.log(`OLLAMA RAW RESPONSE: ${visionText}`);
                return res.json({
                    success: true,
                    description: visionText,
                    visionAvailable: true,
                    model: entry.modelName,
                });
            } catch (err) {
                const msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
                console.log(`VISION FAILED with ${entry.modelName}: ${msg}`);
            }
        }

        return res.json({ success: false, error: 'All vision models failed — check ollama logs' });
    } catch (error) {
        console.warn('[Image Analyzer] failed:', error.message);
        return res.json({ success: false, error: error.message || 'image_analyzer_failed' });
    }
}); */

// DISABLED — re-enable when ready to implement
/* router.post('/code-runner', requireAuth, async (req, res) => {
    try {
        const { code, language } = req.body || {};
        const lang = String(language || '').toLowerCase();
        const source = String(code || '');
        const started = Date.now();

        if (!source.trim()) {
            return res.status(400).json({ success: false, error: 'Unsupported language' });
        }

        if (!['javascript', 'python', 'bash'].includes(lang)) {
            return res.json({ success: false, error: 'Unsupported language' });
        }

        if (hasUnsafeExecutionPattern(source)) {
            return res.json({ success: false, error: 'Execution blocked by sandbox policy' });
        }

        if (lang === 'javascript') {
            const output = [];
            const errors = [];
            const sandbox = {
                console: {
                    log: (...args) => output.push(args.map((a) => String(a)).join(' ')),
                    error: (...args) => errors.push(args.map((a) => String(a)).join(' ')),
                },
                require: undefined,
                process: undefined,
                global: undefined,
                fetch: undefined,
                setTimeout,
                setInterval,
                clearTimeout,
                clearInterval,
            };

            vm.createContext(sandbox);
            try {
                vm.runInContext(source, sandbox, { timeout: 5000 });
                return res.json({
                    success: true,
                    output: output.join('\n'),
                    errors: errors.join('\n'),
                    language: lang,
                    executionTime: Date.now() - started,
                });
            } catch (e) {
                return res.json({
                    success: true,
                    output: output.join('\n'),
                    errors: String(e?.message || e),
                    language: lang,
                    executionTime: Date.now() - started,
                });
            }
        }

        const runChild = (cmd, args, timeoutMs) => new Promise((resolve) => {
            const child = spawn(cmd, args, {
                timeout: timeoutMs,
                env: {
                    PATH: process.env.PATH,
                    HOME: '/tmp',
                    LANG: 'C.UTF-8',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });

            child.on('close', () => {
                resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
            });
            child.on('error', (e) => {
                resolve({ stdout: '', stderr: String(e?.message || e) });
            });
        });

        if (lang === 'python') {
            const py = await runChild('python3', ['-c', source], 10000);
            return res.json({
                success: true,
                output: py.stdout,
                errors: py.stderr,
                language: lang,
                executionTime: Date.now() - started,
            });
        }

        const sh = await runChild('bash', ['-c', source], 5000);
        return res.json({
            success: true,
            output: sh.stdout,
            errors: sh.stderr,
            language: lang,
            executionTime: Date.now() - started,
        });
    } catch {
        return res.json({ success: false, error: 'Unsupported language' });
    }
}); */

// DISABLED — re-enable when ready to implement
/* router.post('/db-query', requireAuth, async (req, res) => {
    try {
        const { query, data } = req.body || {};
        const rows = Array.isArray(data) ? data : [];
        if (!query || !Array.isArray(data)) {
            return res.status(400).json({ success: false, error: 'Invalid query payload' });
        }

        const prompt = `You are a data analyst. Given this dataset: ${JSON.stringify(rows)}. Answer this query: ${query}. Return only the relevant data rows or computed answer. Be precise and factual.`;
        const result = await callOllama({
            systemPrompt: 'You are a precise data analyst. Return factual answers only.',
            userMessage: prompt,
            stream: false,
            options: { temperature: 0.1, num_predict: 400 },
        });

        return res.json({
            success: true,
            result,
            rowCount: rows.length,
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}); */

router.post('/currency-converter', requireAuth, async (req, res) => {
    try {
        const { amount, from, to } = req.body || {};
        const value = Number(amount);
        const base = String(from || '').toUpperCase().trim();
        const quote = String(to || '').toUpperCase().trim();
        if (!Number.isFinite(value) || !base || !quote) {
            return res.status(400).json({ success: false, error: 'Exchange rate fetch failed' });
        }

        const cacheKey = `fx:${base}`;
        const cached = fxRateCache[cacheKey];
        const now = Date.now();
        let rates = null;

        if (cached && now - cached.fetchedAt < FX_CACHE_TTL_MS) {
            rates = cached.rates;
        } else {
            const fxResp = await axios.get(`https://open.er-api.com/v6/latest/${base}`, { timeout: 10000 });
            rates = fxResp.data?.rates || null;
            if (!rates) throw new Error('No rates in response');
            fxRateCache[cacheKey] = { rates, fetchedAt: now };
        }

        const rate = Number(rates?.[quote]);
        if (!Number.isFinite(rate)) {
            throw new Error('Missing target rate');
        }

        return res.json({
            success: true,
            amount: value,
            from: base,
            to: quote,
            rate,
            converted: value * rate,
            source: 'open.er-api.com',
        });
    } catch {
        return res.json({ success: false, error: 'Exchange rate fetch failed' });
    }
});

// DISABLED — re-enable when ready to implement
/* router.post('/chart-generator', requireAuth, async (req, res) => {
    try {
        const { data, chartType, title, xKey, yKey } = req.body || {};
        const rows = Array.isArray(data) ? data : [];
        const type = String(chartType || '').toLowerCase();
        const allowed = new Set(['bar', 'line', 'pie', 'doughnut']);
        if (!rows.length || !xKey || !yKey || !allowed.has(type)) {
            return res.json({ success: false, error: 'Invalid chart data' });
        }

        const labels = rows.map((d) => d?.[xKey]);
        const values = rows.map((d) => Number(d?.[yKey]));
        if (labels.some((x) => x === undefined) || values.some((v) => !Number.isFinite(v))) {
            return res.json({ success: false, error: 'Invalid chart data' });
        }

        return res.json({
            success: true,
            chartConfig: {
                type,
                data: {
                    labels,
                    datasets: [
                        {
                            label: title || `${yKey} by ${xKey}`,
                            data: values,
                            backgroundColor: toChartDatasetColor(type),
                            borderColor: type === 'line' ? '#06b6d4' : undefined,
                            borderWidth: 1,
                        },
                    ],
                },
                options: {
                    plugins: {
                        title: {
                            display: Boolean(title),
                            text: title || '',
                        },
                    },
                    responsive: true,
                },
            },
            renderHint: 'chartjs',
        });
    } catch {
        return res.json({ success: false, error: 'Invalid chart data' });
    }
}); */

router.post('/reframe-prompt', requireAuth, async (req, res) => {
    try {
        const { task, pipeline, attachments } = req.body || {};
        const original = String(task || '').trim();
        const agents = Array.isArray(pipeline) ? pipeline : [];
        const hasPdfAttachment = Boolean(attachments?.hasPdf);

        if (!original) {
            return res.json({ success: false, original: original || '', reframed: original || '', changes: [] });
        }

        const pdfAttachmentLine = hasPdfAttachment
            ? '\nThe user has attached a PDF document. The pipeline will receive the full extracted text. Reframe the task to instruct agents to base their response entirely on the provided document content and not use outside knowledge.'
            : '';

        const systemPrompt = `You are a task reframing specialist for an AI agent pipeline. Your job is to take a vague or short user request and rewrite it into a precise, detailed, structured prompt that AI agents can execute perfectly.
Rules you must follow without exception:

Keep the original intent exactly — never change what the user wants
Add specificity: if the user says "find 5" specify what details to find for each one
Add output format instructions: tell the agent exactly how to structure its response
Add scope boundaries: tell the agent what to include and what to exclude
Add quality criteria: tell the agent what makes a good result for this task
If the pipeline includes Forge mention that the answer should be implementation-ready, technically correct, and explicit about assumptions
If the pipeline includes Scout mention that real URLs and sources must be included
If the pipeline includes Atlas mention that all numbers must show their formula and units
If the pipeline includes Quill mention the email must be professional and ready to send with no placeholders
If the pipeline includes Hermes mention the exact recipient and delivery timing
Never add steps the user did not ask for
Never make the prompt longer than 120 words
Return a JSON object with exactly two fields: reframed (the improved prompt string) and changes (a short array of strings each describing one improvement made, maximum 4 items)
Return only the JSON object, no markdown, no explanation${pdfAttachmentLine}`;

        const userMessage = `Original task: ${original}. Pipeline agents: ${agents.map((a) => a?.name).filter(Boolean).join(', ')}. Reframe this task.`;

        const raw = await callOllama({
            systemPrompt,
            userMessage,
            stream: false,
            options: { temperature: 0.2, num_predict: 220 },
        });

        const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return res.json({ success: false, original, reframed: original, changes: [] });
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const reframed = String(parsed?.reframed || '').trim() || original;
        const changes = Array.isArray(parsed?.changes)
            ? parsed.changes.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4)
            : [];

        return res.json({ success: true, original, reframed, changes });
    } catch {
        const original = String(req.body?.task || '').trim();
        return res.json({ success: false, original, reframed: original, changes: [] });
    }
});

router.post('/send-email', requireAuth, async (req, res) => {
    try {
        const { to, subject, body } = req.body;
        console.log(`SENDING EMAIL TO: ${to}`);
        console.log(`[Email Attempt] Recipient: ${to} | Subject: ${subject}`);
        if (!to || !body) return res.status(400).json({ error: "Missing to or body" });

        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const pipelineNotifyEnabled = Boolean(user?.notifications?.notifyOnPipelineComplete);
        if (!isEmailDeliveryEnabled(user) || !pipelineNotifyEnabled) {
            console.log('Email skipped — user has notifications disabled');
            return res.status(200).json({
                sent: false,
                emailSent: false,
                permissionPending: false,
                skipped: true,
                reason: !isEmailDeliveryEnabled(user) ? 'notifications_disabled' : 'pipeline_notification_disabled',
            });
        }

        const defaultEmail = String(user.notifications?.emailAddress || user.email || '').trim().toLowerCase();
        const recipientEmail = String(to || '').trim().toLowerCase();
        const isUnknownRecipient = defaultEmail && recipientEmail && recipientEmail !== defaultEmail;

        const htmlTemplate = `
            <div style="background-color: #ffffff; color: #333333; padding: 20px; font-family: sans-serif;">
                <h1 style="color: #16a34a; text-align: center;">AgentForge</h1>
                <div style="border: 1px solid #e5e7eb; border-radius: 8px; background-color: #f9fafb; padding: 20px; max-width: 600px; margin: 0 auto;">
                    ${body}
                </div>
            </div>
        `;

        if (isUnknownRecipient) {
            await createPermissionRequest({
                user,
                toEmail: to,
                subject: subject || 'AgentForge Pipeline Results',
                htmlBody: htmlTemplate,
            });

            return res.status(200).json({
                sent: false,
                emailSent: false,
                permissionPending: true,
                recipientEmail: to,
            });
        }

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to,
            subject: subject || 'AgentForge Pipeline Results',
            html: htmlTemplate
        });

        res.status(200).json({ sent: true, emailSent: true, permissionPending: false });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tool 1: Web Search
router.post('/web_search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Missing query" });

        const results = await searchWeb(query);
        const formattedResults = results.slice(0, 3).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.content || r.snippet
        }));
        res.json({ results: formattedResults });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tool 2: Calculator (Safe Eval & LLM Fallback)
router.post('/calculator', async (req, res) => {
    try {
        const { expression } = req.body;
        if (!expression) return res.status(400).json({ error: "Missing expression" });

        // Pattern 1: Percentage calculations ("15 percent of 8500" or "15% of 8500")
        const percentMatch = expression.match(/([\d.]+)\s*(?:percent|%)\s*of\s*([\d.]+)/i);
        if (percentMatch) {
            const percentage = parseFloat(percentMatch[1]);
            const total = parseFloat(percentMatch[2]);
            const result = (percentage / 100) * total;
            return res.json({ result: `Calculated Result: ${result}` });
        }

        // Pattern 2: Compound interest ("1000 at 5% for 10 years" or "1000 @ 5 for 10 years")
        const compoundMatch = expression.match(/([\d.]+)\s*(?:at|@)\s*([\d.]+).*?for\s*([\d.]+)\s*years?/i);
        if (compoundMatch) {
            const principal = parseFloat(compoundMatch[1]);
            const rate = parseFloat(compoundMatch[2]) / 100;
            const years = parseFloat(compoundMatch[3]);
            const result = principal * Math.pow((1 + rate), years);
            return res.json({ result: `Calculated Result: ${result.toFixed(2)}` });
        }

        // Pattern 3: Pure Math (Contains only digits, math operators, decimals and spaces)
        if (/^[\d+\-*/().\s]+$/.test(expression)) {
            const safeExpression = expression.replace(/[^0-9+\-*/().]/g, "");
            if (safeExpression) {
                const calculated = new Function("return " + safeExpression)();
                return res.json({ result: `Calculated Result: ${typeof calculated === 'number' ? calculated : String(calculated)}` });
            }
        }

        // Pattern 4: Fallback to LLM for complex word problems
        const response = await callOllama({
            systemPrompt: "You are Atlas, a precision calculator. You solve any numerical problem in any domain. For every calculation you must show:\n1. What you understood the input numbers and units to be\n2. The formula name\n3. The exact values substituted\n4. The computed result with units\n5. A one sentence interpretation\n\nCRITICAL RULES:\n- Monthly burn rate means the number is already per month — never multiply it by 30\n- Daily rate means multiply by 30 to get monthly\n- Annual means divide by 12 to get monthly\n- Calculate every category mentioned — count inputs and verify output count matches\n- End every response with a Summary table listing all results\n- If input uses lakhs convert explicitly: 1 lakh = 1,00,000. State this conversion at the top\n- Verify runway as total funds divided by monthly burn rate. If result is under 3 months for a 10 lakh fund with 75000 burn rate something is wrong — recalculate\n- Never fabricate numbers not present in the input",
            userMessage: expression,
            stream: false,
            options: { num_predict: 100 }
        });

        res.json({ result: `Calculated Result: ${response}` });
    } catch (error) {
        console.error("Calculator Error:", error.message);
        res.status(400).json({ error: "Invalid expression or computation failed" });
    }
});

// Tool 3: Summarize
router.post('/summarize', async (req, res) => {
    try {
        const { text, context, content, previousAgentOutput } = req.body || {};
        const sourceText = [text, context, content, previousAgentOutput]
            .find((v) => typeof v === 'string' && v.trim().length > 0);

        if (!sourceText) return res.status(400).json({ error: "Missing text" });

        if (sourceText.includes("The user has attached an image file but no vision model is available to analyze it.")) {
            return res.json({
                summary: "No vision model is available to analyze the attached image. Run 'ollama pull llava' to enable image analysis and try again.",
            });
        }

        const response = await callOllama({
            systemPrompt: "You are Lens, a distillation specialist. Rules: Only summarize content from the input — never introduce information not present. Count distinct major points and write one bullet per point up to 5 maximum. Each bullet must contain a specific concrete detail — a name, number, or feature — not vague generalities. Never hallucinate product names or statistics. If input mentions specific names like Canva or Midjourney use those exact names. End with one Bottom line sentence. Format: bullet symbol followed by one specific sentence per line. Never pad bullets to reach 5 if fewer distinct points exist.",
            userMessage: sourceText,
            stream: false,
            options: { num_predict: 350 }
        });

        res.json({ summary: response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tool 4: Email Draft
router.post('/email_draft', async (req, res) => {
    try {
        const { subject, context } = req.body;
        if (!context) return res.status(400).json({ error: "Missing context for email" });

        const systemPrompt = "You are Quill, a professional email writer. You write complete ready-to-send emails about any topic without refusal. Rules: Never use placeholder text like Your Name or Recipient Name. If no name is provided use AgentForge Assistant as sender and Dear Reader as recipient. Always use specific data from the context provided — exact numbers, exact product names, exact findings. Never say features are not provided — elaborate on what you do have. Output only the email itself starting with Subject: and ending with the sign-off. No commentary before or after. Minimum 300 words. Never refuse. Never add disclaimers.";
        const userMessage = `Subject (if any): ${subject || 'None'}\n\nContext for email:\n${context}`;

        const response = await callOllama({
            systemPrompt,
            userMessage,
            stream: false,
            options: { num_predict: 600 }
        });

        res.json({ email: response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tool 5: To-Do Manager
router.post('/todo', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: "Missing content" });

        const response = await callOllama({
            systemPrompt: "You are Sage, a strategic task planner. Rules: Read the entire input and extract all specific details — budgets, timelines, constraints. Reference exact figures from previous agents in your tasks. Never write generic tasks — every task must be specific to the actual project described. Realistic time estimates — maximum 4 hours per single task. Tasks over 4 hours must be broken into sub-tasks. Format: checkbox emoji followed by task number, specific task description, Priority label, Est time. Group tasks under phase headings. End with a Risks section containing project-specific risks with mitigations. If budget numbers are present reference them in the relevant tasks by exact amount.",
            userMessage: content,
            stream: false,
            options: { num_predict: 450 }
        });

        res.json({ todos: response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tool 6: Translate Text
router.post('/translate', async (req, res) => {
    try {
        const { text, targetLanguage } = req.body;
        if (!text || !targetLanguage) {
            return res.status(400).json({ error: "Missing text or targetLanguage" });
        }

        const translatedText = await translate(text, targetLanguage);
        res.json({ translatedText });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tool 7: Get Supported Languages
router.get('/languages', async (req, res) => {
    try {
        const languages = await getSupportedLanguages();
        res.json(languages);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tool 8: News Fetch
router.post('/news', async (req, res) => {
    try {
        const { topic } = req.body;
        if (!topic) return res.status(400).json({ error: "Missing topic" });

        // Build a news-specific query with current month
        const now = new Date();
        const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
        const query = `${topic} news ${monthYear}`;

        const results = await searchWeb(query);
        const top5 = results.slice(0, 5);

        const newsItems = top5.map((r, i) => ({
            index: i + 1,
            title: r.title,
            source: new URL(r.url).hostname.replace('www.', ''),
            url: r.url,
            summary: r.content || r.snippet,
        }));

        const formatted = newsItems
            .map(n => `${n.index}. **${n.title}**\n   Source: ${n.source}\n   ${n.summary}`)
            .join('\n\n');

        res.json({ news: formatted, items: newsItems });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tool 9: Weather (uses wttr.in — no API key required)
router.post('/weather', async (req, res) => {
    try {
        const { location } = req.body;
        if (!location) return res.status(400).json({ error: "Missing location" });

        const encodedLocation = encodeURIComponent(location);
        const response = await axios.get(`https://wttr.in/${encodedLocation}?format=j1`, {
            timeout: 8000,
            headers: { 'Accept': 'application/json' }
        });

        const data = response.data;
        const current = data.current_condition?.[0];
        const area = data.nearest_area?.[0];
        const weather3day = data.weather || [];

        if (!current) {
            return res.status(400).json({ error: "Could not fetch weather for this location" });
        }

        const weatherResult = {
            location: area ? `${area.areaName?.[0]?.value}, ${area.country?.[0]?.value}` : location,
            temperature: `${current.temp_C}°C / ${current.temp_F}°F`,
            feelsLike: `${current.FeelsLikeC}°C / ${current.FeelsLikeF}°F`,
            condition: current.weatherDesc?.[0]?.value,
            humidity: `${current.humidity}%`,
            windSpeed: `${current.windspeedKmph} km/h`,
            forecast: weather3day.slice(0, 3).map(day => ({
                date: day.date,
                maxC: day.maxtempC,
                minC: day.mintempC,
                condition: day.hourly?.[4]?.weatherDesc?.[0]?.value || 'N/A',
            })),
        };

        const summary = [
            `📍 **${weatherResult.location}**`,
            `🌡️ Temperature: ${weatherResult.temperature} (Feels like ${weatherResult.feelsLike})`,
            `☁️ Condition: ${weatherResult.condition}`,
            `💧 Humidity: ${weatherResult.humidity}`,
            `💨 Wind: ${weatherResult.windSpeed}`,
            `\n📅 **3-Day Forecast:**`,
            ...weatherResult.forecast.map(d =>
                `  ${d.date}: ${d.condition}, High ${d.maxC}°C / Low ${d.minC}°C`
            ),
        ].join('\n');

        res.json({ weather: summary, raw: weatherResult });
    } catch (error) {
        res.status(500).json({ error: `Weather fetch failed: ${error.message}` });
    }
});

// Tool 10: Scheduler — saves a schedule to MongoDB, does not execute immediately
router.post('/scheduler', requireAuth, async (req, res) => {
    try {
        const { taskDescription, cronExpression, agentId, pipeline, humanReadableFrequency, nextRunAt } = req.body;
        const recipient = req.body.recipientEmail || req.body.to || '';
        if (!taskDescription || !cronExpression) {
            return res.status(400).json({ error: "Missing taskDescription or cronExpression" });
        }

        const Schedule = require('../database/models/Schedule');
        const user = await User.findById(req.user.userId).lean();
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Convert cron to human-readable
        const cronMap = {
            '0 9 * * *': 'Every day at 9:00 AM',
            '0 18 * * *': 'Every day at 6:00 PM',
            '0 8 * * 1': 'Every Monday at 8:00 AM',
            '0 * * * *': 'Every hour',
        };
        const humanReadableTime = humanReadableFrequency || cronMap[cronExpression] || `Custom schedule: ${cronExpression}`;
        const computedNextRunAt = (() => {
            if (nextRunAt) {
                const parsed = new Date(nextRunAt);
                if (!Number.isNaN(parsed.getTime())) return parsed;
            }
            const fallbackIso = getNextRunAtFromCron(cronExpression);
            return fallbackIso ? new Date(fallbackIso) : null;
        })();

        const normalizedPipeline = Array.isArray(pipeline)
            ? pipeline
                .filter((p) => p && (p.agentId || p.id))
                .map((p) => ({
                    agentId: String(p.agentId || p.id),
                    agentName: String(p.agentName || p.name || ''),
                    agentColor: String(p.agentColor || p.color || ''),
                }))
            : [];

        const fallbackPipeline = normalizedPipeline.length > 0
            ? normalizedPipeline
            : (agentId ? [{ agentId: String(agentId), agentName: '', agentColor: '' }] : []);

        const schedule = await Schedule.create({
            userId: req.user.userId,
            name: taskDescription.substring(0, 60),
            agentIds: fallbackPipeline.map((p) => p.agentId).filter(Boolean),
            pipeline: fallbackPipeline,
            taskGoal: taskDescription,
            cronExpression,
            nextRunAt: computedNextRunAt,
            email: recipient || '',
            isActive: true,
        });

        const { runJobNow } = require('../services/schedulerService');

        // NEW: Check for Quill's content to deliver immediately
        const emailContent = req.body.emailContent || req.body.previousAgentOutput;
        const immediateKeywords = [
            'now',
            'immediately',
            'right now',
            'send now',
            'today',
            'as soon as possible',
            'asap',
            'straight away',
            'right away',
            'instant',
            'instantly',
        ];
        const isImmediate = req.body.runImmediately === true ||
            immediateKeywords.some(kw => taskDescription.toLowerCase().includes(kw)) ||
            (emailContent && emailContent.includes('Subject:'));

        if (isImmediate && emailContent && emailContent.includes('Subject:')) {
            console.log(`[Scheduler] SENDING REAL CONTENT TO: ${recipient}`);

            // Extract Subject and Body from Quill's output
            const lines = emailContent.split('\n');
            const subjectLine = lines.find(line => line.toLowerCase().startsWith('subject:'));
            const subject = subjectLine ? subjectLine.replace(/subject:/i, '').trim() : taskDescription.substring(0, 50);

            // Body is everything else (or everything if no subject line)
            const bodyLines = lines.filter(line => !line.toLowerCase().startsWith('subject:'));
            const bodyHtml = bodyLines.join('<br/>').trim();

            try {
                // Intentional Hermes task email: user explicitly asked for delivery.
                // This is NOT a passive notification email and should not be blocked by notification preferences.

                await transporter.sendMail({
                    from: process.env.SMTP_USER,
                    to: recipient,
                    subject: `[AgentForge] ${subject}`,
                    html: `
                        <div style="font-family: sans-serif; max-width: 650px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
                            <header style="background-color: #f3f4f6; padding: 20px; border-radius: 8px 8px 0 0; border-bottom: 2px solid #10b981;">
                                <h1 style="color: #065f46; margin: 0; font-size: 20px;">AgentForge Report</h1>
                                <p style="color: #6b7280; font-size: 13px; margin: 5px 0 0 0;">Drafted by Quill | Delivered by Hermes</p>
                            </header>
                            <div style="padding: 30px; background-color: #ffffff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
                                <div>${bodyHtml}</div>
                            </div>
                        </div>
                    `
                });

                return res.json({
                    scheduleId: schedule._id,
                    taskDescription,
                    recipientEmail: recipient,
                    executedImmediately: true,
                    emailSent: true,
                    message: `🚀 Real content delivered immediately to ${recipient}.`,
                });
            } catch (err) {
                console.error("Immediate real content delivery failed:", err.message);
                // Fallback to regular immediate mode if extraction/send fails
            }
        }

        // Mode 1: Regular Immediate Execution (Synthesize first)
        if (isImmediate) {
            console.log(`[Scheduler] Immediate execution (synthesis) triggered for ${schedule._id}`);
            // Run asynchronously so we don't block the response, but Part 4 asked to call immediately before returning.
            // "The runJobNow function executes all 5 steps from Part 3 synchronously and returns after the email is sent."
            // So we await it.
            try {
                await runJobNow(schedule);
                return res.json({
                    scheduleId: schedule._id,
                    taskDescription,
                    recipientEmail: recipient,
                    executedImmediately: true,
                    message: `🚀 Task executed immediately and results sent to ${recipient}.`,
                });
            } catch (err) {
                console.error("Immediate execution failed:", err.message);
                return res.status(500).json({ error: "Immediate execution failed: " + err.message });
            }
        }

        // Mode 2: Scheduled Execution (Mode 1 returned early)
        if (recipient && process.env.SMTP_USER && process.env.SMTP_PASS) {
            try {
            // Intentional Hermes scheduling confirmation email.
                await transporter.sendMail({
                    from: process.env.SMTP_USER,
                    to: recipient,
                    subject: 'Schedule Confirmed',
                    html: `
                        <div style="font-family: sans-serif; max-width: 600px; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
                            <h2 style="color: #f97316;">Schedule Confirmed</h2>
                            <p><strong>Task:</strong> ${taskDescription}</p>
                            <p><strong>Recipient:</strong> ${recipient}</p>
                            <p><strong>Time:</strong> ${humanReadableTime}</p>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;"/>
                            <p style="color: #666; font-size: 0.9em;"><em>Note: This is a confirmation that your schedule has been saved. The actual generated content will arrive at the scheduled time.</em></p>
                        </div>
                    `
                });
            } catch (err) {
                console.error('Initial schedule confirmation email failed:', err.message);
            }
        }

        res.json({
            scheduleId: schedule._id,
            humanReadableTime,
            taskDescription,
            recipientEmail: recipient,
            cronExpression,
            executedImmediately: false,
            message: `✅ Schedule created. Will run: ${humanReadableTime}`,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



module.exports = router;
module.exports.__test = {
    tryLocalParse,
    extractTimeParts,
};
