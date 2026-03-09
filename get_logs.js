require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }).then(async () => {
    const Task = require('./database/models/CompletedTask');
    const User = require('./database/models/User');
    const user = await User.findOne({ email: 'abhijeetroy20@outlook.com' });
    if (!user) { console.error('No user'); process.exit(1); }
    const tasks = await Task.find({ userId: user._id }).sort({ createdAt: -1 }).limit(4);

    for (const t of tasks.reverse()) {
        console.log(`\n================== TASK: ${t.taskGoal} ==================`);
        for (const log of (t.logsJson || [])) {
            console.log(`[${(log.type || '').toUpperCase()}] ${log.agentName || 'System'}: ${log.content}`);
        }
    }
    process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
