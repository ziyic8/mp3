const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Task name is required']
  },
  description: {
    type: String,
    default: ''
  },
  deadline: {
    type: Date,
    required: [true, 'Task deadline is required']
  },
  completed: {
    type: Boolean,
    default: false
  },
  assignedUser: {
    type: String,
    default: ''
  },
  assignedUserName: {
    type: String,
    default: 'unassigned'
  },
  dateCreated: {
    type: Date,
    default: Date.now
  }
});

// create indexes
TaskSchema.index({ completed: 1 });
TaskSchema.index({ assignedUser: 1 });
TaskSchema.index({ deadline: 1 });

module.exports = mongoose.model('Task', TaskSchema);