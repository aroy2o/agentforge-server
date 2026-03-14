const mongoose = require('mongoose');

const completedTaskSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    pipelineId: { type: String },
    taskGoal: { type: String, required: true },
    finalOutput: { type: String, default: '' },
    logsJson: { type: [Object], default: [] },
    agentCount: { type: Number, default: 0 },
    durationMs: { type: Number },
    createdAt: { type: Date, default: Date.now },
    originalTask: { type: String },
    optimisedTask: { type: String },
});

// Compound index for efficient sorting by user + date
completedTaskSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('CompletedTask', completedTaskSchema);
