const express = require('express');
const router = express.Router();
const { searchWeb } = require('../services/tavily');
const { callOllama } = require('../services/ollama');
const { translate, getSupportedLanguages } = require('../services/translator');
const axios = require('axios');
const transporter = require('../services/mailer');

router.post('/send-email', async (req, res) => {
    try {
        const { to, subject, body } = req.body;
        console.log(`SENDING EMAIL TO: ${to}`);
        console.log(`[Email Attempt] Recipient: ${to} | Subject: ${subject}`);
        if (!to || !body) return res.status(400).json({ error: "Missing to or body" });

        const htmlTemplate = `
            <div style="background-color: #ffffff; color: #333333; padding: 20px; font-family: sans-serif;">
                <h1 style="color: #16a34a; text-align: center;">AgentForge</h1>
                <div style="border: 1px solid #e5e7eb; border-radius: 8px; background-color: #f9fafb; padding: 20px; max-width: 600px; margin: 0 auto;">
                    ${body}
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to,
            subject: subject || 'AgentForge Pipeline Results',
            html: htmlTemplate
        });

        res.status(200).json({ sent: true });
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
            systemPrompt: "You are a calculator. Solve this mathematical problem and return only the number with a one-line explanation.",
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
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: "Missing text" });

        const response = await callOllama({
            systemPrompt: "You are a summarization engine. Extract only the key points. Output exactly 3 to 5 bullet points. Each bullet is one sentence maximum. No preamble, no conclusion, no meta-commentary. Just the bullets.",
            userMessage: text,
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

        const systemPrompt = "You are a professional email writer. Write a complete ready-to-send email with Subject line, greeting, body paragraphs, and sign-off. Use clear professional language. Output only the email itself with no explanation or commentary before or after it.";
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
            systemPrompt: "You are a task planning specialist. Convert the given goal into a numbered action list. Each item starts with a checkbox emoji followed by a number and the task. Be specific and actionable. Output between 5 and 10 items. No introduction or conclusion text. Just the numbered list.",
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
router.post('/scheduler', async (req, res) => {
    try {
        const { taskDescription, cronExpression, recipientEmail, agentId, userId } = req.body;
        if (!taskDescription || !cronExpression) {
            return res.status(400).json({ error: "Missing taskDescription or cronExpression" });
        }

        const Schedule = require('../database/models/Schedule');

        // Convert cron to human-readable
        const cronMap = {
            '0 9 * * *': 'Every day at 9:00 AM',
            '0 18 * * *': 'Every day at 6:00 PM',
            '0 8 * * 1': 'Every Monday at 8:00 AM',
            '0 * * * *': 'Every hour',
        };
        const humanReadableTime = cronMap[cronExpression] || `Custom schedule: ${cronExpression}`;

        const schedule = await Schedule.create({
            userId: userId || 'anonymous',
            name: taskDescription.substring(0, 60),
            agentIds: agentId ? [agentId] : [],
            taskGoal: taskDescription,
            cronExpression,
            email: recipientEmail || '',
            isActive: true,
        });

        const { runJobNow } = require('../services/schedulerService');

        // NEW: Check for Quill's content to deliver immediately
        const emailContent = req.body.emailContent || req.body.previousAgentOutput;
        const immediateKeywords = ['now', 'immediately', 'right now', 'send now', 'today'];
        const isImmediate = req.body.runImmediately === true ||
            immediateKeywords.some(kw => taskDescription.toLowerCase().includes(kw)) ||
            (emailContent && emailContent.includes('Subject:'));

        if (isImmediate && emailContent && emailContent.includes('Subject:')) {
            console.log(`[Scheduler] SENDING REAL CONTENT TO: ${recipientEmail}`);

            // Extract Subject and Body from Quill's output
            const lines = emailContent.split('\n');
            const subjectLine = lines.find(line => line.toLowerCase().startsWith('subject:'));
            const subject = subjectLine ? subjectLine.replace(/subject:/i, '').trim() : taskDescription.substring(0, 50);

            // Body is everything else (or everything if no subject line)
            const bodyLines = lines.filter(line => !line.toLowerCase().startsWith('subject:'));
            const bodyHtml = bodyLines.join('<br/>').trim();

            try {
                await transporter.sendMail({
                    from: process.env.SMTP_USER,
                    to: recipientEmail,
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
                    recipientEmail,
                    executedImmediately: true,
                    emailSent: true,
                    message: `🚀 Real content delivered immediately to ${recipientEmail}.`,
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
                    recipientEmail,
                    executedImmediately: true,
                    message: `🚀 Task executed immediately and results sent to ${recipientEmail}.`,
                });
            } catch (err) {
                console.error("Immediate execution failed:", err.message);
                return res.status(500).json({ error: "Immediate execution failed: " + err.message });
            }
        }

        // Mode 2: Scheduled Execution (Mode 1 returned early)
        if (recipientEmail && process.env.SMTP_USER && process.env.SMTP_PASS) {
            try {
                await transporter.sendMail({
                    from: process.env.SMTP_USER,
                    to: recipientEmail,
                    subject: 'Schedule Confirmed',
                    html: `
                        <div style="font-family: sans-serif; max-width: 600px; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
                            <h2 style="color: #f97316;">Schedule Confirmed</h2>
                            <p><strong>Task:</strong> ${taskDescription}</p>
                            <p><strong>Recipient:</strong> ${recipientEmail}</p>
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
            recipientEmail,
            cronExpression,
            executedImmediately: false,
            message: `✅ Schedule created. Will run: ${humanReadableTime}`,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



module.exports = router;
