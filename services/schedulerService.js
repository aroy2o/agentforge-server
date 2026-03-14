/**
 * schedulerService.js
 * Loads all active schedules from MongoDB on startup.
 * For each schedule, creates a node-cron job that runs the agent pipeline
 * and delivers the output via email using nodemailer.
 */

const cron = require('node-cron');
const cronParser = require('cron-parser');
const transporter = require('./mailer');
const { callOllama } = require('./ollama');
const { searchWeb } = require('./tavily');
const Schedule = require('../database/models/Schedule');
const Agent = require('../database/models/Agent');

// Map of scheduleId -> cron task (for cleanup/cancellation)
const activeCronJobs = new Map();
const runningJobs = new Set();

function getNextRunAt(cronExpression) {
    try {
        const expr = cronParser.CronExpressionParser.parse(cronExpression);
        const next = expr.next();
        return next?.toDate ? next.toDate() : new Date(next);
    } catch {
        return null;
    }
}

async function executeSchedule(schedule) {
    const { _id, taskGoal, agentIds, email, name } = schedule;
    const scheduleKey = _id.toString();

    if (runningJobs.has(scheduleKey)) {
        console.warn(`[Scheduler] Schedule ${scheduleKey} is already running. Skipping overlapping run.`);
        return;
    }
    runningJobs.add(scheduleKey);

    console.log(`[Scheduler] Firing schedule "${name}" (${_id})`);

    try {
        const agentId = agentIds?.[0];
        if (!agentId) throw new Error("No agent ID found for schedule");

        const agent = await Agent.findById(agentId);
        if (!agent) throw new Error("Agent not found");

        let userMessage = taskGoal;

        // Step 2: Web Search if enabled
        if (agent.tools && agent.tools.includes('web_search')) {
            console.log(`[Scheduler] Performing web search for: ${taskGoal}`);
            try {
                const results = await searchWeb(taskGoal);
                const formattedResults = results.slice(0, 5).map((r, i) =>
                    `${i + 1}. **${r.title}**\n   Source: ${r.url}\n   ${r.content || r.snippet}`
                ).join('\n\n');
                userMessage = `Task Description: ${taskGoal}\n\nSearch Results:\n${formattedResults}\n\nPlease synthesize the above results into a final report as requested.`;
            } catch (searchErr) {
                console.error(`[Scheduler] Web search failed:`, searchErr.message);
            }
        }

        // Step 3: Call Ollama
        console.log(`[Scheduler] Calling Ollama for schedule ${_id}`);
        const output = await callOllama({
            systemPrompt: agent.personality,
            userMessage: userMessage,
            stream: false
        });

        // Step 4: Send Real Content Email
        if (email) {
            // Intentional Hermes task email from an explicit scheduled workflow.
            console.log(`[Scheduler] Sending real content email to ${email}`);

            // Extract Subject from output if present, else fallback
            const lines = output.split('\n');
            const subjectLine = lines.find(line => line.toLowerCase().startsWith('subject:'));
            const subject = subjectLine ? subjectLine.replace(/subject:/i, '').trim() :
                (taskGoal.length > 50 ? taskGoal.substring(0, 50) + '...' : taskGoal);

            // Filter out Subject line from body
            const bodyHtml = lines
                .filter(line => !line.toLowerCase().startsWith('subject:'))
                .join('<br/>')
                .trim();

            // Format HTML with proper styling
            const htmlTemplate = `
                <div style="font-family: sans-serif; max-width: 650px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
                    <header style="background-color: #f3f4f6; padding: 20px; border-radius: 8px 8px 0 0; border-bottom: 2px solid #10b981;">
                        <h1 style="color: #065f46; margin: 0; font-size: 20px;">AgentForge Report</h1>
                        <p style="color: #6b7280; font-size: 13px; margin: 5px 0 0 0;">Automated Delivery | ${new Date().toLocaleDateString()}</p>
                    </header>
                    <div style="padding: 30px; background-color: #ffffff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
                        <div>${bodyHtml}</div>
                    </div>
                </div>
            `;

            await transporter.sendMail({
                from: process.env.SMTP_USER,
                to: email,
                subject: `[AgentForge] ${subject}`,
                html: htmlTemplate
            });
            console.log(`[Scheduler] Email delivered to ${email}`);
        }

        // Step 5: Log and Update DB
        console.log(`SCHEDULED JOB EXECUTED for ${_id}, recipient: ${email}, timestamp: ${new Date().toISOString()}`);

        const nextRunAt = getNextRunAt(schedule.cronExpression);
        await Schedule.findByIdAndUpdate(_id, {
            $set: { lastRunAt: new Date(), nextRunAt, lastRunStatus: 'success', lastError: null },
            $inc: { runCount: 1 },
        });

    } catch (err) {
        console.error(`[Scheduler] Error running schedule ${_id}:`, err.message);

        // Record failure in DB
        try {
            await Schedule.findByIdAndUpdate(_id, {
                $set: {
                    lastRunStatus: 'failed',
                    lastError: String(err.message || 'Unknown error').slice(0, 500),
                    lastErrorAt: new Date(),
                },
            });
        } catch (dbErr) {
            console.warn('[Scheduler] Failed to record error in DB:', dbErr.message);
        }

        // Send failure notification email to the schedule owner if email is set
        if (email) {
            try {
                await transporter.sendMail({
                    from: process.env.SMTP_USER,
                    to: email,
                    subject: `[AgentForge] Scheduled job failed: ${name || _id}`,
                    html: `
                        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937;">
                            <header style="background: #fef2f2; padding: 16px 20px; border-radius: 8px 8px 0 0; border-bottom: 2px solid #ef4444;">
                                <h2 style="margin: 0; color: #b91c1c; font-size: 16px;">Scheduled Job Failed</h2>
                            </header>
                            <div style="padding: 20px; background: #fff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
                                <p><strong>Schedule:</strong> ${name || _id}</p>
                                <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
                                <p><strong>Error:</strong> ${String(err.message || 'Unknown error')}</p>
                                <p style="color: #6b7280; font-size: 13px; margin-top: 16px;">
                                    The job will attempt to run again at the next scheduled time.
                                    You can also trigger a manual run from the AgentForge Scheduler page.
                                </p>
                            </div>
                        </div>
                    `,
                });
                console.log(`[Scheduler] Failure notification sent to ${email}`);
            } catch (mailErr) {
                console.warn('[Scheduler] Failed to send failure notification email:', mailErr.message);
            }
        }

        throw err; // Re-throw for runJobNow handling
    } finally {
        runningJobs.delete(scheduleKey);
    }
}

async function runJobNow(schedule) {
    console.log(`[Scheduler] Running job IMMEDIATELY for schedule ${schedule._id}`);
    await executeSchedule(schedule);
}

function scheduleJob(schedule) {
    const { _id, cronExpression, name } = schedule;

    if (!cron.validate(cronExpression)) {
        console.warn(`[Scheduler] Invalid cron expression for schedule ${_id}: "${cronExpression}"`);
        return;
    }

    const task = cron.schedule(cronExpression, async () => {
        await executeSchedule(schedule);
    });

    const nextRunAt = getNextRunAt(cronExpression);
    Schedule.findByIdAndUpdate(_id, { $set: { nextRunAt } }).catch((err) => {
        console.warn(`[Scheduler] Failed to persist nextRunAt for schedule ${_id}: ${err.message}`);
    });

    activeCronJobs.set(_id.toString(), task);
    console.log(`[Scheduler] Registered schedule "${name}" — ${cronExpression}`);
}

async function loadAndStartAll() {
    try {
        const schedules = await Schedule.find({ isActive: true }).lean();

        console.log(`[Scheduler] Loading ${schedules.length} active schedules...`);

        for (const schedule of schedules) {
            scheduleJob(schedule);
        }

        console.log(`[Scheduler] All schedules loaded.`);
    } catch (err) {
        console.error('[Scheduler] Failed to load schedules:', err.message);
    }
}

function stopSchedule(scheduleId) {
    const task = activeCronJobs.get(scheduleId.toString());
    if (task) {
        task.stop();
        activeCronJobs.delete(scheduleId.toString());
        console.log(`[Scheduler] Stopped schedule ${scheduleId}`);
    }
}

function stopAll() {
    for (const [id, task] of activeCronJobs) {
        task.stop();
    }
    activeCronJobs.clear();
    console.log('[Scheduler] All cron jobs stopped.');
}

module.exports = { loadAndStartAll, scheduleJob, stopSchedule, stopAll, executeSchedule, runJobNow };
