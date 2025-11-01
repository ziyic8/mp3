const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');

function parseJSONQueryParam(req, primary, alias) {
  const raw = req.query[primary] ?? (alias ? req.query[alias] : undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new SyntaxError(`Invalid JSON for ${primary}`);
    err.code = 'BAD_JSON';
    throw err;
  }
}

/** GET /api/users */
router.get('/', async (req, res) => {
  try {
    const where  = parseJSONQueryParam(req, 'where');
    const sort   = parseJSONQueryParam(req, 'sort');
    const select = parseJSONQueryParam(req, 'select', 'filter');
    const skip   = Number.isFinite(+req.query.skip)  ? +req.query.skip  : 0;
    const limit  = Number.isFinite(+req.query.limit) ? +req.query.limit : 0;
    const count  = String(req.query.count).toLowerCase() === 'true';

    let q = User.find(where || {});
    if (sort)   q = q.sort(sort);
    if (select) q = q.select(select);
    if (skip)   q = q.skip(skip);
    if (limit)  q = q.limit(limit);

    if (count) {
      const c = await User.countDocuments(where || {});
      return res.status(200).json({ message: 'OK', data: c });
    }

    const rows = await q.exec();
    return res.status(200).json({ message: 'OK', data: rows });
  } catch (err) {
    if (err instanceof SyntaxError || err?.code === 'BAD_JSON') {
      return res.status(400).json({ message: 'Invalid query JSON', data: {} });
    }
    return res.status(500).json({ message: 'Server error', data: {} });
  }
});

/** POST /api/users - WITH TRANSACTION */
router.post('/', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { name, email, pendingTasks } = req.body;
    if (!name || !email) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Missing required fields', data: {} });
    }

    const dup = await User.findOne({ email }).session(session);
    if (dup) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Email already exists', data: {} });
    }

    // Create user within transaction
    const [user] = await User.create(
      [{ name, email, pendingTasks: Array.isArray(pendingTasks) ? pendingTasks : [] }],
      { session }
    );

    // Keep only valid, NOT completed task ids
    let validTasks = [];
    if (Array.isArray(pendingTasks) && pendingTasks.length) {
      validTasks = await Task.find({ 
        _id: { $in: pendingTasks }, 
        completed: false 
      }).session(session).distinct('_id');
    }

    // Assign those tasks to this user (task side)
    if (validTasks.length) {
      await Task.updateMany(
        { _id: { $in: validTasks } },
        { assignedUser: user._id.toString(), assignedUserName: user.name },
        { session }
      );
      
      // Cross-user cleanup
      await User.updateMany(
        { _id: { $ne: user._id }, pendingTasks: { $in: validTasks } },
        { $pull: { pendingTasks: { $in: validTasks } } },
        { session }
      );
      
      // Normalize this user's pendingTasks
      await User.findByIdAndUpdate(
        user._id, 
        { pendingTasks: validTasks.map(String) },
        { session }
      );
      user.pendingTasks = validTasks.map(String);
    } else {
      await User.findByIdAndUpdate(user._id, { pendingTasks: [] }, { session });
      user.pendingTasks = [];
    }

    // Commit transaction
    await session.commitTransaction();
    return res.status(201).json({ message: 'User created', data: user });
    
  } catch (err) {
    await session.abortTransaction();
    return res.status(500).json({ message: 'Server error', data: {} });
  } finally {
    session.endSession();
  }
});

/** GET /api/users/:id */
router.get('/:id', async (req, res) => {
  try {
    const select = parseJSONQueryParam(req, 'select', 'filter');
    const u = await User.findById(req.params.id).select(select || {});
    if (!u) return res.status(404).json({ message: 'User not found', data: {} });
    return res.status(200).json({ message: 'OK', data: u });
  } catch (err) {
    if (err && err.name === 'CastError') {
      return res.status(404).json({ message: 'User not found', data: {} });
    }
    if (err instanceof SyntaxError || err?.code === 'BAD_JSON') {
      return res.status(400).json({ message: 'Invalid select JSON', data: {} });
    }
    return res.status(500).json({ message: 'Server error', data: {} });
  }
});

/** PUT /api/users/:id - WITH TRANSACTION
 *  IMPORTANT: We preserve dateCreated even with overwrite: true
 */
router.put('/:id', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const id = req.params.id;
    let user = await User.findById(id).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found', data: {} });
    }

    const { name, email, pendingTasks } = req.body;
    if (!name || !email || !Array.isArray(pendingTasks)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Missing required fields', data: {} });
    }

    // Check for duplicate email
    const dup = await User.findOne({ email, _id: { $ne: id } }).session(session);
    if (dup) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Email already exists', data: {} });
    }

    // Store the original dateCreated
    const originalDateCreated = user.dateCreated;

    // 1) Unassign current NOT completed tasks of this user
    await Task.updateMany(
      { assignedUser: user._id.toString(), completed: false },
      { assignedUser: '', assignedUserName: 'unassigned' },
      { session }
    );

    // 2) Only keep valid, NOT completed task ids
    const validTasks = pendingTasks.length
      ? await Task.find({ 
          _id: { $in: pendingTasks }, 
          completed: false 
        }).session(session).distinct('_id')
      : [];

    // 3) Assign those tasks to this user
    if (validTasks.length) {
      await Task.updateMany(
        { _id: { $in: validTasks } },
        { assignedUser: user._id.toString(), assignedUserName: name },
        { session }
      );
      
      // 4) Cross-user cleanup
      await User.updateMany(
        { _id: { $ne: user._id }, pendingTasks: { $in: validTasks } },
        { $pull: { pendingTasks: { $in: validTasks } } },
        { session }
      );
    }

    // 5) Overwrite user document with normalized pendingTasks BUT preserve dateCreated
    user = await User.findByIdAndUpdate(
      id,
      { 
        name, 
        email, 
        pendingTasks: validTasks.map(String),
        dateCreated: originalDateCreated  // ← PRESERVE this field!
      },
      { new: true, overwrite: true, session }
    );

    // Commit transaction
    await session.commitTransaction();
    return res.status(200).json({ message: 'User updated', data: user });
    
  } catch (err) {
    await session.abortTransaction();
    
    if (err && err.name === 'CastError') {
      return res.status(404).json({ message: 'User not found', data: {} });
    }
    if (err && (err.code === 11000 || String(err.message || '').includes('E11000'))) {
      return res.status(400).json({ message: 'Email already exists', data: {} });
    }
    return res.status(500).json({ message: 'Server error', data: {} });
  } finally {
    session.endSession();
  }
});

/** DELETE /api/users/:id - WITH TRANSACTION */
router.delete('/:id', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const u = await User.findById(req.params.id).session(session);
    if (!u) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'User not found', data: {} });
    }

    // Unassign all NOT completed tasks from this user
    await Task.updateMany(
      { assignedUser: u._id.toString(), completed: false },
      { assignedUser: '', assignedUserName: 'unassigned' },
      { session }
    );
    
    // Delete the user
    await User.deleteOne({ _id: u._id }, { session });

    await session.commitTransaction();
    return res.status(204).end();
  } catch (err) {
    await session.abortTransaction();
    
    if (err && err.name === 'CastError') {
      return res.status(404).json({ message: 'User not found', data: {} });
    }
    return res.status(500).json({ message: 'Server error', data: {} });
  } finally {
    session.endSession();
  }
});

module.exports = router;
