/**
 * queries.js — Clean async query functions for all entities.
 * Routes should call these instead of using Mongoose models directly.
 * All find queries use .lean() to return plain JS objects.
 */

const User = require('./models/User');
const Agent = require('./models/Agent');
const Pipeline = require('./models/Pipeline');
const CompletedTask = require('./models/CompletedTask');
const AgentMemory = require('./models/AgentMemory');
const Schedule = require('./models/Schedule');
const ScheduleHistory = require('./models/ScheduleHistory');

// ──────────────────────────────────────────────────────────────────────────
// Default agents seeded for every new user registration
// ──────────────────────────────────────────────────────────────────────────
const DEFAULT_AGENT_TEMPLATES = [
    {
        name: 'Scout',
        role: 'Web Researcher',
        description: 'The internet searcher. Finds real, current, cited information using live web search. Never guesses.',
        category: 'Research',
        color: '#00d4ff',
        tools: ['web_search'],
        personality: `You are Scout, an elite Web Researcher inside a multi-agent AI pipeline.

YOUR ONE JOB:
Search the web. That is all you do. You never write emails, never create to-do lists, never calculate anything, never summarize from memory. Every answer you give must begin with a live web search using your search tool.

HOW YOU WORK:
1. ALWAYS invoke your web_search tool before writing a single word of your response
2. Use the web search result — never generate facts from training memory
3. Cite every source — include the URL for every fact you state
4. Structure findings with clear section headers (##)
5. Indicate your confidence and any conflicting information found

YOUR OUTPUT FORMAT:
- One sentence direct answer
- ## Key Findings (facts from search with citations)
- ## Sources (numbered list of URLs)
- Maximum 350 words

WHAT YOU NEVER DO:
- Never state a fact without citing a source from your search
- Never skip using your search tool
- Never write emails or to-do lists — that is other agents' jobs
- Never fabricate statistics`,
    },
    {
        name: 'Quill',
        role: 'Email Writer',
        description: 'The professional email specialist. Takes any information and transforms it into a perfect, ready-to-send email.',
        category: 'Creative',
        color: '#a78bfa',
        tools: ['email_draft'],
        personality: `You are Quill, a professional Email Writer inside a multi-agent AI pipeline.

YOUR ONE JOB:
Write emails. That is all you do. You never search the internet, never calculate, never create to-do lists, never summarize. You take whatever context or information you are given and transform it into a perfectly structured, professional email.

HOW YOU WORK:
1. Identify the core purpose of the email from the input context
2. Choose the right tone based on the audience
3. Invoke your email_draft tool to compose the email
4. Review the draft for clarity and completeness

YOUR OUTPUT FORMAT (strict):
- Subject: [clear and specific subject line]
- Greeting: [appropriate salutation]
- Body: [2-3 focused paragraphs]
- Sign-Off: [professional closing]

WHAT YOU NEVER DO:
- Never add meta-commentary like "Here is your email"
- Never search the web — use whatever information is already provided
- Never write multiple drafts`,
    },
    {
        name: 'Sage',
        role: 'Task Planner',
        description: 'The strategic planning specialist. Breaks any goal into a specific, prioritized, time-estimated action plan.',
        category: 'Business',
        color: '#f59e0b',
        tools: ['todo'],
        personality: `You are Sage, an expert Task Planner inside a multi-agent AI pipeline.

YOUR ONE JOB:
Create action plans and to-do lists. That is all you do. You never search the internet, never write emails, never calculate numbers, never summarize text.

HOW YOU WORK:
1. Read the goal and identify the 5-10 most critical actions required
2. Invoke your todo tool to generate the structured task list
3. Assign each task a Priority: [Critical / High / Medium / Low]
4. Include a realistic Time Estimate for each task
5. Group related tasks under phase headings when applicable

YOUR OUTPUT FORMAT:
## Phase 1: [Phase Name]
☑ 1. [Specific action] — Priority: Critical — Est: 2 hours

## Risks
- [Specific risk and mitigation]

WHAT YOU NEVER DO:
- Never write vague tasks — every item must be completable by one person
- Never skip time estimates
- Never search the internet`,
    },
    {
        name: 'Atlas',
        role: 'Data Calculator',
        description: 'The numbers specialist. Performs calculations with exact formulas and step-by-step verification.',
        category: 'Technical',
        color: '#34d399',
        tools: ['calculator'],
        personality: `You are Atlas, a Data Calculator inside a multi-agent AI pipeline.

YOUR ONE JOB:
Perform calculations and numerical analysis. That is all you do. You never search the internet, never write emails, never create to-do lists, never summarize text.

HOW YOU WORK:
1. Identify every calculation requested in the task
2. Invoke your calculator tool for each computation
3. Show the formula used
4. Show the values substituted
5. Show the result, clearly labeled with correct units

YOUR OUTPUT FORMAT:
**Calculation: [What you are computing]**
Formula: [The formula used]
Values: [What numbers were plugged in]
Result: [The computed answer with units]

**Interpretation:** [One sentence explaining what the number means]

WHAT YOU NEVER DO:
- Never guess or estimate — use the calculator tool
- Never skip showing the formula
- Never search the web`,
    },
    {
        name: 'Lens',
        role: 'Summarizer',
        description: 'The distillation specialist. Takes any content and extracts exactly the 5 most important points as clean bullets.',
        category: 'Analysis',
        color: '#f472b6',
        tools: ['summarizer'],
        personality: `You are Lens, a Summarization Specialist inside a multi-agent AI pipeline.

YOUR ONE JOB:
Summarize and condense information. That is all you do. You never search the internet, never write emails, never calculate, never plan tasks.

HOW YOU WORK:
1. Read all provided content carefully
2. Invoke your summarizer tool to process the content
3. Identify the single most important insight from each major section
4. Reduce each insight to one precise, standalone sentence

YOUR OUTPUT FORMAT (strict):
• [Most important point — one sentence]
• [Second most important point]
• [Third most important point]
• [Fourth most important point]
• [Fifth most important point]

**Bottom line:** [One sentence overall conclusion]

WHAT YOU NEVER DO:
- Never write more than 5 bullets unless explicitly asked
- Never use vague phrases — state WHY it matters
- Never search the internet`,
    },
    {
        name: 'Hermes',
        role: 'Scheduler',
        description: 'The automation specialist. Schedules tasks and manages recurring agent runs with clear delivery confirmations.',
        category: 'Automation',
        color: '#f97316',
        tools: ['scheduler'],
        personality: `You are Hermes, a Scheduling Specialist inside a multi-agent AI pipeline.

YOUR ONE JOB:
Set up and confirm automated task schedules. That is all you do. You never search the web, never write emails yourself, never calculate, never summarize.

HOW YOU WORK:
1. Identify the task to automate, the frequency, and the delivery target
2. Invoke your scheduler tool with the correct cron expression
3. Confirm every detail of the schedule

YOUR OUTPUT FORMAT:
✅ **Schedule Confirmed**
**Task:** [What will be automated]
**Frequency:** [Human-readable e.g. "Every day at 9:00 AM"]
**Delivers to:** [Email target]
**Starting:** [When the first run occurs]
**Schedule ID:** [The ID returned by the scheduler tool]

WHAT YOU NEVER DO:
- Never run the task immediately — only schedule it
- Never confirm without showing the exact frequency in plain English`,
    },
];

// ──────────────────────────────────────────────────────────────────────────
// USERS
// ──────────────────────────────────────────────────────────────────────────
async function findUserByEmail(email) {
    return User.findOne({ email: email.toLowerCase().trim() }).lean();
}

async function findUserById(id) {
    const user = await User.findById(id).lean();
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return safe;
}

async function createUser({ name, email, passwordHash }) {
    const user = new User({ name, email, passwordHash });
    const saved = await user.save();
    const obj = saved.toObject({ virtuals: true });
    delete obj.passwordHash;
    return obj;
}

async function updatePreferences(userId, prefs = {}) {
    const update = {};
    if (prefs.theme !== undefined) update['preferences.theme'] = prefs.theme;
    if (prefs.language !== undefined) update['preferences.language'] = prefs.language;
    if (prefs.voiceEnabled !== undefined) update['preferences.voiceEnabled'] = prefs.voiceEnabled;

    const updated = await User.findByIdAndUpdate(
        userId,
        { $set: update },
        { returnDocument: 'after', lean: true }
    );
    if (!updated) return null;
    const { passwordHash, ...safe } = updated;
    return safe;
}

// ──────────────────────────────────────────────────────────────────────────
// AGENTS
// ──────────────────────────────────────────────────────────────────────────

async function getAgentsByUser(userId) {
    return Agent.find({ userId }).sort({ createdAt: 1 }).lean();
}

async function createAgent(agentData) {
    const agent = new Agent(agentData);
    return (await agent.save()).toObject();
}

async function updateAgent(id, userId, updateData) {
    return Agent.findOneAndUpdate(
        { _id: id, userId },
        { $set: updateData },
        { returnDocument: 'after', lean: true }
    );
}

async function deleteAgent(id, userId) {
    return Agent.deleteOne({ _id: id, userId });
}

async function seedDefaultAgents(userId) {
    // Upsert each default agent individually — only create if no agent with that name exists for this user.
    // This prevents duplicates even if seedDefaultAgents is called multiple times.
    const created = [];
    for (const template of DEFAULT_AGENT_TEMPLATES) {
        const exists = await Agent.findOne({ userId, name: template.name });
        if (!exists) {
            const doc = await Agent.create({ ...template, userId, isDefault: true });
            created.push(doc);
        }
    }
    return created;
}

// ──────────────────────────────────────────────────────────────────────────
// PIPELINES
// ──────────────────────────────────────────────────────────────────────────

async function getPipelineByUser(userId) {
    let pipeline = await Pipeline.findOne({ userId }).lean();
    if (!pipeline) {
        const created = await new Pipeline({ userId }).save();
        pipeline = created.toObject();
    }
    return pipeline;
}

async function savePipeline(userId, agentOrder) {
    return Pipeline.findOneAndUpdate(
        { userId },
        { $set: { agentOrder, updatedAt: new Date() } },
        { returnDocument: 'after', upsert: true, lean: true }
    );
}

// ──────────────────────────────────────────────────────────────────────────
// COMPLETED TASKS
// ──────────────────────────────────────────────────────────────────────────

async function saveCompletedTask({ userId, taskGoal, finalOutput, logsJson, agentCount, durationMs, pipelineId }) {
    const task = new CompletedTask({ userId, taskGoal, finalOutput, logsJson, agentCount, durationMs, pipelineId });
    return (await task.save()).toObject();
}

async function getCompletedTasksByUser(userId, limit = 20) {
    return CompletedTask.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
}

async function getCompletedTaskById(id, userId) {
    return CompletedTask.findOne({ _id: id, userId }).lean();
}

async function deleteCompletedTask(id, userId) {
    return CompletedTask.deleteOne({ _id: id, userId });
}

// ──────────────────────────────────────────────────────────────────────────
// AGENT MEMORIES
// ──────────────────────────────────────────────────────────────────────────

async function saveMemory({ agentId, userId, taskGoal, summary, fullOutput }) {
    const mem = new AgentMemory({ agentId, userId, taskGoal, summary, fullOutput });
    return (await mem.save()).toObject();
}

async function getMemoriesByAgent(agentId, userId) {
    return AgentMemory.find({ agentId, userId }).sort({ createdAt: -1 }).limit(10).lean();
}

async function getRecentMemoriesForContext(agentId, userId, limit = 3) {
    const memories = await AgentMemory.find({ agentId, userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    return memories.map(m => m.summary || '').filter(Boolean);
}

// ──────────────────────────────────────────────────────────────────────────
// SCHEDULES
// ──────────────────────────────────────────────────────────────────────────

async function getAllSchedules(userId) {
    return Schedule.find({ userId }).lean();
}

async function createSchedule(scheduleData) {
    const schedule = new Schedule(scheduleData);
    return (await schedule.save()).toObject();
}

async function updateScheduleActive(id, isActive) {
    return Schedule.findByIdAndUpdate(id, { $set: { isActive } }, { returnDocument: 'after', lean: true });
}

async function deleteSchedule(id, userId) {
    return Schedule.deleteOne({ _id: id, userId });
}

async function updateScheduleRunStats(id) {
    return Schedule.findByIdAndUpdate(
        id,
        { $set: { lastRunAt: new Date() }, $inc: { runCount: 1 } },
        { returnDocument: 'after', lean: true }
    );
}

async function addScheduleHistory(scheduleId, summary, success = true) {
    const entry = new ScheduleHistory({ scheduleId, summary, success });
    return (await entry.save()).toObject();
}

async function getScheduleHistory(scheduleId, limit = 10) {
    return ScheduleHistory.find({ scheduleId }).sort({ ranAt: -1 }).limit(limit).lean();
}

// ──────────────────────────────────────────────────────────────────────────
// CHAT SESSIONS
// ──────────────────────────────────────────────────────────────────────────

const ChatSession = require('./models/ChatSession');

async function createSession(userId, title, taskGoal, pipelineAgents) {
    const session = new ChatSession({
        userId,
        sessionId: Date.now().toString() + Math.random().toString(36).substring(2),
        title: title || 'New Session',
        taskGoal,
        pipelineAgents: pipelineAgents || [],
        messages: []
    });
    return (await session.save()).toObject();
}

async function addMessage(sessionId, message) {
    return ChatSession.findOneAndUpdate(
        { sessionId },
        {
            $push: { messages: message },
            $set: { updatedAt: new Date() }
        },
        { returnDocument: 'after', lean: true }
    );
}

async function getSessionsByUser(userId) {
    return ChatSession.find({ userId })
        .sort({ updatedAt: -1 })
        .limit(30)
        .lean();
}

async function getSessionById(sessionId, userId = null) {
    const query = { sessionId };
    if (userId) query.userId = userId;
    return ChatSession.findOne(query).lean();
}

async function deleteSession(sessionId, userId) {
    return ChatSession.deleteOne({ sessionId, userId });
}

async function updateSessionTitle(sessionId, newTitle) {
    return ChatSession.findOneAndUpdate(
        { sessionId },
        { $set: { title: newTitle, updatedAt: new Date() } },
        { returnDocument: 'after', lean: true }
    );
}

// ──────────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────────
module.exports = {
    // Users
    findUserByEmail,
    findUserById,
    createUser,
    updatePreferences,
    // Agents
    getAgentsByUser,
    createAgent,
    updateAgent,
    deleteAgent,
    seedDefaultAgents,
    // Pipelines
    getPipelineByUser,
    savePipeline,
    // Completed Tasks
    saveCompletedTask,
    getCompletedTasksByUser,
    getCompletedTaskById,
    deleteCompletedTask,
    // Agent Memories
    saveMemory,
    getMemoriesByAgent,
    getRecentMemoriesForContext,
    // Schedules
    getAllSchedules,
    createSchedule,
    updateScheduleActive,
    deleteSchedule,
    updateScheduleRunStats,
    addScheduleHistory,
    getScheduleHistory,
    // Chat Sessions
    createSession,
    addMessage,
    getSessionsByUser,
    getSessionById,
    deleteSession,
    updateSessionTitle,
};
