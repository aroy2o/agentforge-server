const express = require('express');
const router = express.Router();
const { default: ollama } = require('ollama');
const { textToSpeech } = require('../services/elevenlabs');
const { parseVoiceCommand } = require('../services/voiceCommandParser');
const { requireAuth } = require('../middleware/auth');

function parseJsonObjectSafely(rawText) {
    const text = String(rawText || '').trim();

    // Method 1: direct parse
    try {
        const result = JSON.parse(text);
        console.log('PARSE METHOD USED: 1 (direct)');
        return result;
    } catch {}

    // Method 2: strip markdown fences then parse
    const stripped = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        const result = JSON.parse(stripped);
        console.log('PARSE METHOD USED: 2 (stripped fences)');
        return result;
    } catch {}

    // Method 3: extract first { to last }
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
            const result = JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
            console.log('PARSE METHOD USED: 3 (brace extraction)');
            return result;
        } catch {}
    }

    // Method 4: find any single-line object
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const result = JSON.parse(trimmed);
                console.log('PARSE METHOD USED: 4 (single-line)');
                return result;
            } catch {}
        }
    }

    console.log('ALL PARSE ATTEMPTS FAILED — raw:', text);
    return null;
}

function suggestPipelineForTask(taskText = '') {
    const t = String(taskText || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return [];

    const has = (re) => re.test(t);
    const hasDelivery = has(/email|mail|send|delivery|deliver|forward|notify|inbox/);
    const hasCode = has(/code|coding|program|developer|debug|bug|fix|error|stack trace|exception|react|node|javascript|typescript|python|java|sql|api|build|implement|refactor|test/);
    const hasSearch = has(/search|find|latest|research|look up|news|compare|what is|who is/);
    const hasSummarize = has(/summarize|summary|key points|brief|tldr|highlights/);
    const hasCalculate = has(/calculate|roi|profit|budget|cost|revenue|margin|price|currency|percent/);
    const hasPlan = has(/plan|planner|roadmap|learning path|schedule|strategy|milestone|next steps|daily tasks|study plan/);
    const hasWrite = has(/write|draft|article|blog|post|content|summary writeup|compose/);

    let pipeline = [];

    if (hasCode) pipeline = ['Forge'];
    else if (hasSearch && hasSummarize) pipeline = ['Scout', 'Lens'];
    else if (hasSearch && hasPlan) pipeline = ['Scout', 'Sage'];
    else if (hasSearch && hasCalculate) pipeline = ['Scout', 'Atlas'];
    else if (hasSearch) pipeline = ['Scout'];
    else if (hasPlan) pipeline = ['Sage'];
    else if (hasCalculate) pipeline = ['Atlas'];
    else if (hasWrite) pipeline = ['Quill'];
    else if (hasSummarize) pipeline = ['Lens'];

    // Add delivery only when explicitly requested.
    if (hasDelivery) {
        if (!pipeline.includes('Quill')) pipeline.push('Quill');
        if (!pipeline.includes('Hermes')) pipeline.push('Hermes');
    }

    return pipeline;
}

function isItReferenceInstruction(text = '') {
    const normalized = String(text || '').toLowerCase();
    return /\b(do it|run it|create a pipeline for it|pipeline and do it|for it)\b/.test(normalized);
}

function getLastUserTopic(history = []) {
    if (!Array.isArray(history)) return '';
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const turn = history[i];
        if (turn?.role !== 'user') continue;
        const content = String(turn?.content || '').trim();
        if (!content) continue;
        if (isItReferenceInstruction(content)) continue;
        return content;
    }
    return '';
}

function normalizeAssistantJson(candidate) {
    const fallback = {
        speech: "I didn't catch that clearly. Could you say that again?",
        action: null,
        actionData: {},
        followUp: null,
        isConversational: true,
    };

    if (!candidate || typeof candidate !== 'object') return fallback;

    const allowedActions = new Set([
        'navigate', 'run_pipeline', 'stop_pipeline', 'clear_pipeline', 'add_agent', 'remove_agent',
        'set_task', 'fill_schedule_form', 'change_language', 'change_theme', 'export_pdf', 'export_csv', 'create_agent',
        'enable_notifications', 'disable_notifications', 'set_notification_email', 'open_chat',
        'new_chat_session', 'send_chat_message', 'clear_task', 'read_last_result', 'show_schedule_list',
        'pause_all_schedules', 'add_to_calendar',
        // legacy aliases kept for back-compat
        'create_schedule', 'open_form', 'send_chat', 'new_chat', 'save_settings', 'search_web',
    ]);

    const action = allowedActions.has(candidate.action) ? candidate.action : null;
    return {
        speech: String(candidate.speech || fallback.speech).trim() || fallback.speech,
        action,
        actionData: candidate.actionData && typeof candidate.actionData === 'object' ? candidate.actionData : {},
        followUp: candidate.followUp ? String(candidate.followUp) : null,
        isConversational: typeof candidate.isConversational === 'boolean' ? candidate.isConversational : action === null,
    };
}

// POST /api/voice/assistant
router.post('/assistant', requireAuth, async (req, res) => {
    try {
        const parseFallback = {
            speech: 'I heard you but had trouble forming a response. Could you say that again?',
            action: null,
            actionData: {},
            followUp: null,
            isConversational: true,
        };

        const { message, context = {}, conversationHistory = [] } = req.body || {};
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid message' });
        }

        const model = process.env.ARIA_MODEL || process.env.OLLAMA_MODEL || 'llama3.2';
        const safeHistory = Array.isArray(conversationHistory)
            ? conversationHistory
                .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string')
                .slice(-6)
            : [];
        console.log('CONVERSATION HISTORY LENGTH:', Array.isArray(conversationHistory) ? conversationHistory.length : 0);

        const userName = String(context.userName || 'there');
        const currentPage = String(context.currentPage || 'Unknown');
        const pipeline = Array.isArray(context.pipeline) ? context.pipeline.join(', ') : String(context.pipeline || 'none');
        const currentTask = String(context.currentTask || 'none');
        const activeSchedulesCount = Number(context.activeSchedulesCount || 0);
        const notificationsEnabled = Boolean(context.notificationsEnabled);
        const currentTheme = String(context.currentTheme || 'light');
        const currentLanguage = String(context.currentLanguage || 'English');

        const sysPrompt = `You are ARIA, the voice assistant for AgentForge. You are smart, direct, and helpful. Always respond with ONLY a valid JSON object - no markdown, no code fences, no extra text.

    JSON format (all keys required):
    {"speech":"...","action":null,"actionData":{},"followUp":null,"isConversational":true}

    CURRENT CONTEXT:
    - User: ${userName}
    - Page: ${currentPage}
    - Pipeline agents: ${pipeline}
    - Current task: ${currentTask}
    - Active schedules: ${activeSchedulesCount}
    - Notifications: ${notificationsEnabled}
    - Theme: ${currentTheme}
    - Language: ${currentLanguage}

    AGENTS AVAILABLE:
    Forge=coding, debugging, technical guidance, Scout=web research, Lens=summarizer, Atlas=financial calculator, Sage=strategic planner, Quill=email drafter, Hermes=email sender and scheduler

    VALID ACTIONS AND WHEN TO USE THEM:
    - navigate -> user wants to go somewhere. actionData: {"page":"dashboard|agents|scheduler|chat|settings"}
    - run_pipeline -> user says run, go, execute, start, do it, yes. actionData: {}
    - stop_pipeline -> user says stop, cancel, halt. actionData: {}
    - set_task -> user describes something to research, find, calculate, or write. actionData: {"task":"full task description","suggestedPipeline":["Agent1","Agent2"]}

    CRITICAL — ACTION SELECTION RULES:
    When deciding between set_task and fill_schedule_form:
    - "create a pipeline", "set up a pipeline", "build a pipeline", "make a pipeline", "pipeline for this" → action: set_task (runs once now)
    - "schedule this", "schedule it", "run this every day", "automate this", "recurring", "daily" → action: fill_schedule_form (runs repeatedly on a timer)
    NEVER return fill_schedule_form when user says "create a pipeline" or "pipeline for this". A pipeline runs once now. A schedule runs on a recurring timer. These are two completely different things.
    Example: "can you create a pipeline for this" → {"speech":"Creating a pipeline for your task now.","action":"set_task","actionData":{"task":"[use the task from conversation context]","suggestedPipeline":["Scout","Lens","Quill","Hermes"]},"followUp":"Say run pipeline when ready.","isConversational":false}

    - add_agent -> user wants to add a specific agent. actionData: {"agentName":"Forge|Scout|Lens|Atlas|Sage|Quill|Hermes"}
    - remove_agent -> user wants to remove an agent. actionData: {"agentName":"..."}
    - clear_pipeline -> user wants to reset the pipeline. actionData: {}
    - fill_schedule_form -> use this only when all required scheduling details are present. NEVER use placeholder emails like abhijeet@example.com, user@example.com, or any @example.com address. If the user has not provided a real email address in this conversation, set email to null in actionData and ask the user for their email address. An invented email is worse than no email. Never invent or assume the task content. If the user says schedule a task but does not describe the task, set action to null and ask what they want to schedule. Only use prior context when the user explicitly says "use that task" or "same task". Before returning fill_schedule_form check what is missing: if task is unclear ask what to schedule, if frequency is missing ask when to run, if email is missing ask for email. Ask only one question at a time. Only return fill_schedule_form when task, frequency, and email are all present. Always include suggestedPipeline as an array of agent names. For news/research tasks use ["Scout","Lens"]. If email delivery is mentioned add ["Quill","Hermes"]. actionData: {"task":"...","frequency":"natural language time like every day at 9am","email":"real email address","suggestedPipeline":["Scout","Lens"]}
    - add_to_calendar -> when the user says add to calendar, schedule in my calendar, put it in my calendar, or add to Google Calendar. actionData: {"task":"...","date":"today|tomorrow|specific date if mentioned","time":"specific time if mentioned"}
    - When users speak email addresses, they may say "at the rate", "at sign", or "at" instead of @ and "dot com/in/org/net" instead of extensions. Always reconstruct actionData.email using proper @ and . symbols. Example: "abhijeet roy 20 at the rate outlook dot com" -> "abhijeetroy20@outlook.com".
    - If a spoken email only includes the domain part (for example "at outlook dot com" or "at gmail dot com") and does not include a username before @, do not guess from the user's name. Set action to null and ask: "What is the full email address including the part before the @ symbol?"
    - When user says "no" to sending an email but mentions calendar, treat it as add_to_calendar intent and do not treat it as rejection. Example: "No send me daily lessons schedule it in my calendar" means no email, add it to Google Calendar.
    - change_theme -> dark mode or light mode. actionData: {"theme":"dark|light"}
    - change_language -> user wants different language. actionData: {"language":"Hindi|Spanish|French|German|Tamil|Bengali|English"}
    - export_pdf -> export or download results as PDF. actionData: {}
    - export_csv -> export as CSV or spreadsheet. actionData: {}
    - create_agent -> build or create a new custom agent. actionData: {"name":"if mentioned"}
    - enable_notifications -> turn on alerts or notifications. actionData: {}
    - disable_notifications -> turn off alerts or notifications. actionData: {}
    - set_notification_email -> set email for notifications. actionData: {"email":"..."}
    - open_chat -> open chat page. actionData: {}
    - new_chat_session -> new chat or fresh conversation. actionData: {}
    - send_chat_message -> send the current typed message. actionData: {}
    - clear_task -> clear or reset the task input. actionData: {}
    - read_last_result -> read results, what did agents find, what was the output. actionData: {}
    - show_schedule_list -> list schedules, what automations do I have. actionData: {}
    - pause_all_schedules -> pause everything, stop all automations. actionData: {}

    CONVERSATION RULES:
    - Answer general knowledge questions directly and confidently in speech. Never say you cannot answer factual questions.
    - If the user's intent is ambiguous ask one short clarifying question.
    - For conversational replies, confirmations, and navigation keep speech under 25 words. For content responses where the user explicitly asks for a plan, list, explanation, steps, or breakdown speak up to 150 words. Never cut off mid-sentence. Never say "Here is X:" and then stop. Always include the actual content after the colon.
    - Use the user's first name occasionally but not every single response.
    - Never say "I heard you but had trouble" for real questions - only use that if the input was genuinely unintelligible noise.
    - If the user says "yes", "do it", "go ahead", "confirm", "ok" after you proposed an action - execute that action.
    - Remember conversation history - refer back to what was said earlier in the conversation.
        - When the user says "do it", "run it", "create a pipeline for it", "pipeline and do it", or any instruction containing "it" as the subject, "it" always refers to the most recent task or topic discussed in the conversation history. Never invent a new task. Read the conversation history, find the last thing the user asked about, and use that as the task. If the last topic was JavaScript learning the pipeline must be about JavaScript learning.
        - Never set a task in actionData that was not mentioned by the user in the current conversation. If you cannot find the task in the conversation history ask the user what task they want to run.
    - When scheduling context appears in square brackets like [Context: Task already set: X], treat those values as already confirmed and do not ask for them again. If task is already set and the user provides email, proceed directly to fill_schedule_form without asking for task again.
        - Select agents based on what the task actually needs:
            Research and web search tasks -> Scout first, then Lens to summarize.
            Coding, debugging, implementation, developer help, software architecture -> Forge.
            Planning, roadmaps, learning paths, schedules, and strategies -> Sage only or Scout then Sage.
            Financial calculations, budgets, ROI -> Atlas only or Scout then Atlas.
            Writing content, articles, summaries -> Quill only.
            Any task that ends with email delivery -> add Quill then Hermes at the end.
            General questions answered from knowledge -> no pipeline needed, answer directly in speech.
            Never add Quill and Hermes unless the user explicitly mentions email, sending, or delivery. A learning plan does not need Quill or Hermes.

    EXAMPLES:
    "read the last result" -> {"speech":"Reading your last pipeline output now.","action":"read_last_result","actionData":{},"followUp":null,"isConversational":false}
    "schedule me to fetch tech news every morning" -> {"speech":"Got it. You want to schedule fetch tech news every morning. What email address should I send it to?","action":null,"actionData":{},"followUp":null,"isConversational":true}
    "can you schedule a task for me" -> {"speech":"Sure! What would you like me to schedule, and when should it run?","action":null,"actionData":{},"followUp":null,"isConversational":true}
    "my email is abhijeet@example.com" -> {"speech":"Thanks. I have your email as abhijeet@example.com. What task should I schedule and when should it run?","action":null,"actionData":{},"followUp":null,"isConversational":true}
    "schedule fetch tech news every morning to abhijeet@example.com" -> {"speech":"Scheduling fetch tech news every morning for abhijeet@example.com now.","action":"fill_schedule_form","actionData":{"task":"fetch tech news","frequency":"every morning","email":"abhijeet@example.com","suggestedPipeline":["Scout","Lens","Quill","Hermes"]},"followUp":null,"isConversational":false}
    "give me a 7 day task planner for learning JavaScript" -> {"speech":"Day 1: Variables and data types. Day 2: Functions and scope. Day 3: Arrays and objects. Day 4: DOM manipulation. Day 5: Events and callbacks. Day 6: Promises and async. Day 7: Build a small project combining everything.","action":null,"actionData":{},"followUp":"Want me to set this as a daily pipeline task?","isConversational":true}
    "schedule it in my calendar" -> {"speech":"Adding that to your Google Calendar now.","action":"add_to_calendar","actionData":{"task":"learn JavaScript in 7 days","date":"today","time":"9am"},"followUp":null,"isConversational":false}
    [After user asked about JavaScript learning] "can you create a pipeline and do it" -> {"speech":"Creating a pipeline for your JavaScript learning plan now. I'll use Sage to build the structured plan.","action":"set_task","actionData":{"task":"Create a detailed 7-day JavaScript learning plan with daily tasks, resources, and exercises","suggestedPipeline":["Sage"]},"followUp":"Say run pipeline when ready.","isConversational":false}
    "what can the agents do" -> {"speech":"Forge helps with coding, Scout searches the web, Lens summarizes, Atlas calculates, Sage plans, Quill drafts emails, and Hermes sends them.","action":null,"actionData":{},"followUp":null,"isConversational":true}
    "help me build a React login form" -> {"speech":"I can set up Forge for that technical task. Ready to run?","action":"set_task","actionData":{"task":"Build a React login form with validation and submission handling","suggestedPipeline":["Forge"]},"followUp":"Say run pipeline when ready.","isConversational":false}
    "find top 5 AI tools and email me" -> {"speech":"I'll set up Scout, Lens, Quill and Hermes for that. Ready to run?","action":"set_task","actionData":{"task":"Find the top 5 AI tools in 2025 with features, pricing and website links","suggestedPipeline":["Scout","Lens","Quill","Hermes"]},"followUp":"Say run pipeline when ready.","isConversational":false}
    "what time is it" -> {"speech":"I don't have access to the current time, but your device clock is always reliable.","action":null,"actionData":{},"followUp":null,"isConversational":true}`;

        const messages = [
            { role: 'system', content: sysPrompt },
            ...safeHistory.map((turn) => ({ role: turn.role, content: turn.content })),
            { role: 'user', content: String(message).trim() },
        ];

        const response = await ollama.chat({
            model,
            messages,
            stream: false,
            format: 'json',
            options: {
                temperature: 0.3,
                num_predict: 200,
            },
        });

        const raw = response?.message?.content || '';
        console.log('OLLAMA RAW:', raw);

        const parsed = parseJsonObjectSafely(raw);
        if (!parsed) {
            console.log('PARSED SPEECH:', parseFallback.speech);
            return res.json(parseFallback);
        }

        console.log('PARSED SPEECH:', parsed.speech);
        const normalized = normalizeAssistantJson(parsed);

        if (normalized.action === 'set_task' && isItReferenceInstruction(message)) {
            const lastTopic = getLastUserTopic(safeHistory);
            if (!lastTopic) {
                normalized.action = null;
                normalized.actionData = {};
                normalized.followUp = null;
                normalized.isConversational = true;
                normalized.speech = 'What task should I create the pipeline for?';
                return res.json(normalized);
            }

            normalized.actionData = {
                ...(normalized.actionData || {}),
                task: lastTopic,
            };
            normalized.speech = 'Creating a pipeline for your previous task now.';
        }

        if (normalized.action === 'set_task' && !Array.isArray(normalized.actionData.suggestedPipeline)) {
            const taskText = String(normalized.actionData.task || message || '').trim();
            normalized.actionData.suggestedPipeline = suggestPipelineForTask(taskText);
        }

        return res.json(normalized);
    } catch (error) {
        console.error('[Voice Assistant Route Error]', error.message);
        return res.json({
            speech: "I didn't catch that clearly. Could you say that again?",
            action: null,
            actionData: {},
            followUp: null,
            isConversational: true,
        });
    }
});

// POST /api/voice/command
// Accepts { transcript } and returns a structured command object parsed by Ollama.
router.post('/command', requireAuth, async (req, res) => {
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
router.post('/speak', requireAuth, async (req, res) => {
    // ElevenLabs removed — browser TTS is active, this endpoint is a stub kept for backwards compatibility.
    return res.status(200).json({ message: 'TTS handled client-side via Web Speech API' });
});

module.exports = router;
