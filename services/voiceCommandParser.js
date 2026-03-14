const { callOllama } = require('./ollama');

const ARIA_SYSTEM_PROMPT = `You are ARIA, the voice assistant for AgentForge, an AI agent platform. You understand natural language commands and also hold conversations. You receive a transcript of what the user said and the recent conversation history. You must return ONLY a valid JSON object with no other text, no markdown, no code fences.

The JSON must have these exact fields:
- action: one of these strings: execute_pipeline, add_agents, remove_agents, clear_pipeline, set_task, run_now, stop_pipeline, create_agent, go_to_page, toggle_theme, toggle_voice, mute, unmute, converse, unknown
- agentNames: array of agent names mentioned, empty array if none
- taskGoal: the task or goal extracted as a string, empty string if none
- shouldExecute: boolean, true if user said "run", "execute", "start", "go", "begin", "do it", "yes", "go ahead", "sure"
- responseSpeech: a natural conversational response that ARIA will speak back to the user. Acknowledge what was understood and confirm the action. Under 2 sentences. Friendly but concise. Examples: "Adding Scout and Quill to your pipeline now." or "I've set your task to researching AI trends. Should I run the pipeline?" or "Pipeline cleared. What would you like to do next?"
- navigateTo: one of "dashboard", "builder", "results", or null if no navigation needed
- confidence: a number from 0.0 to 1.0 indicating how confident you are in the interpretation

Important rules:
- If conversation history shows ARIA asked a question and user replies "yes", "do it", "go ahead", "sure", "yeah", set action to "run_now" and shouldExecute to true
- If user is just chatting with no command, set action to "converse" and give a helpful responseSpeech
- If user asks about capabilities, explain you can manage pipelines, set tasks, navigate pages, control agents, and use Forge for coding and technical help
- Always generate responseSpeech even for unknown actions
- agentNames: match common names like Forge, Scout, Quill, Sage, Atlas, Lens, Hermes, Aria, or any capitalized name the user mentions`;

/**
 * Robustly extracts JSON from an Ollama response string using 4 escalating strategies.
 */
function extractJSON(raw) {
    if (!raw) throw new Error('Empty response from Ollama');

    // Strategy 1: parse the whole thing directly
    try { return JSON.parse(raw.trim()); } catch (_) { }

    // Strategy 2: strip markdown code fences
    const fenceStripped = raw.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    try { return JSON.parse(fenceStripped); } catch (_) { }

    // Strategy 3: pull the first complete {...} block from anywhere in the text
    const firstMatch = raw.match(/\{[\s\S]*?\}/);
    if (firstMatch) { try { return JSON.parse(firstMatch[0]); } catch (_) { } }

    // Strategy 4: try all {...} blocks sorted by length (largest first — most likely complete)
    const allBlocks = [...raw.matchAll(/\{[\s\S]*?\}/g)].map(m => m[0]);
    for (const block of allBlocks.sort((a, b) => b.length - a.length)) {
        try { return JSON.parse(block); } catch (_) { }
    }

    throw new Error(`Could not extract valid JSON from response: ${raw.substring(0, 300)}`);
}

/**
 * Parses a natural language voice transcript into a structured ARIA command.
 * @param {string} transcript - The raw speech-to-text string from the user.
 * @param {Array<{role: string, content: string}>} conversationHistory - Last N conversation turns.
 * @returns {Promise<{action, agentNames, taskGoal, shouldExecute, responseSpeech, navigateTo, confidence}>}
 */
async function parseVoiceCommand(transcript, conversationHistory = []) {
    let rawResponse = '';
    try {
        // Build the user message with conversation context
        const historySection = conversationHistory.length > 0
            ? `Conversation history: ${JSON.stringify(conversationHistory)}\n\n`
            : '';
        const userMessage = `${historySection}User just said: ${transcript}`;

        rawResponse = await callOllama({
            systemPrompt: ARIA_SYSTEM_PROMPT,
            userMessage,
            stream: false,
        });

        console.log('[ARIA Parser] Raw Ollama response:', rawResponse);

        const parsed = extractJSON(rawResponse);

        // Normalize shouldExecute — also scan transcript for intent keywords as fallback
        const keywordExecute = /\b(run|execute|start|go|begin|do it|yes|go ahead|sure|yeah)\b/i.test(transcript);
        const shouldExecute =
            parsed.shouldExecute === true ||
            parsed.shouldExecute === 'true' ||
            (parsed.action === 'run_now') ||
            keywordExecute;

        return {
            action: typeof parsed.action === 'string' ? parsed.action : 'unknown',
            agentNames: Array.isArray(parsed.agentNames) ? parsed.agentNames : [],
            taskGoal: typeof parsed.taskGoal === 'string' ? parsed.taskGoal : '',
            shouldExecute: Boolean(shouldExecute),
            responseSpeech: typeof parsed.responseSpeech === 'string' && parsed.responseSpeech
                ? parsed.responseSpeech
                : "I heard you. Let me take care of that.",
            navigateTo: ['dashboard', 'builder', 'results'].includes(parsed.navigateTo)
                ? parsed.navigateTo
                : null,
            confidence: typeof parsed.confidence === 'number'
                ? Math.min(1, Math.max(0, parsed.confidence))
                : 0.7,
        };
    } catch (err) {
        console.error('[ARIA Parser] Parse failed:', err.message);
        console.error('[ARIA Parser] Raw was:', rawResponse);

        return {
            action: 'unknown',
            agentNames: [],
            taskGoal: transcript,
            shouldExecute: false,
            responseSpeech: "I didn't quite catch that. Could you try rephrasing?",
            navigateTo: null,
            confidence: 0,
        };
    }
}

module.exports = { parseVoiceCommand };
