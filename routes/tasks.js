const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Task = require('../models/task');
const User = require('../models/user');

/** Parse a JSON query param (e.g., where/sort/select/filter). 
 *  If the value is present but not valid JSON -> throw SyntaxError (to return 400).
 *  If absent -> return undefined (use default behavior).
 */
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

/** Coerce typical "true"/"false" strings coming from urlencoded form. */
function toBoolean(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return fallback;
}

/** GET /api/tasks 
 *  Supports where/sort/select (alias: filter)/skip/limit/count.
 *  Default limit = 100 for tasks listing.
 */
router.get('/', async (req, res) => {
  try {
    const where  = parseJSONQueryParam(req, 'where');
    const sort   = parseJSONQueryParam(req, 'sort');
    const select = parseJSONQueryParam(req, 'select', 'filter');

    const skip   = Number.isFinite(+req.query.skip)  ? +req.query.skip  : 0;
    const limit  = Number.isFinite(+req.query.limit) ? +req.query.limit : 100; // default 100
    const count  = String(req.query.count).toLowerCase() === 'true';

    let q = Task.find(where || {});
    if (sort)   q = q.sort(sort);
    if (select) q = q.select(select);
    if (skip)   q = q.skip(skip);
    if (limit)  q = q.limit(limit);

    if (count) {
      const c = await Task.countDocuments(where || {});
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

/** POST /api/tasks - WITH TRANSACTION
 *  Required: name, deadline.
 *  Sync rule:
 *   - If assignedUser is set and completed=false -> add task id to that user's pendingTasks.
 *   - If completed=true -> ensure the task is not in any user's pendingTasks.
 */
router.post('/', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const { name, description = '', deadline, assignedUser = '', assignedUserName, completed } = req.body;
    if (!name || !deadline) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Missing required fields', data: {} });
    }

    const completedBool = toBoolean(completed, false);

    // Resolve assignedUserName if a valid user is provided
    let assignedUserId = String(assignedUser || '');
    let assignedUserNameFinal = 'unassigned';
    if (assignedUserId) {
      const u = await User.findById(assignedUserId).select({ name: 1 }).session(session);
      if (u) assignedUserNameFinal = u.name;
      else assignedUserId = ''; // invalid user id -> treat as unassigned
    }

    // Create task within transaction
    const [t] = await Task.create(
      [{
        name,
        description,
        deadline,
        completed: completedBool,
        assignedUser: assignedUserId,
        assignedUserName: assignedUserId ? assignedUserNameFinal : 'unassigned',
      }],
      { session }
    );

    // Sync: add to user's pendingTasks only if assigned and not completed
    if (assignedUserId && !completedBool) {
      await User.findByIdAndUpdate(
        assignedUserId,
        { $addToSet: { pendingTasks: t._id.toString() } },
        { session }
      );
    }

    await session.commitTransaction();
    return res.status(201).json({ message: 'Task created', data: t });
  } catch (err) {
    await session.abortTransaction();
    return res.status(500).json({ message: 'Server error', data: {} });
  } finally {
    session.endSession();
  }
});

/** GET /api/tasks/:id
 *  Only supports select/filter as a projection.
 */
router.get('/:id', async (req, res) => {
  try {
    const select = parseJSONQueryParam(req, 'select', 'filter');
    const t = await Task.findById(req.params.id).select(select || {});
    if (!t) return res.status(404).json({ message: 'Task not found', data: {} });
    return res.status(200).json({ message: 'OK', data: t });
  } catch (err) {
    if (err && err.name === 'CastError') {
      return res.status(404).json({ message: 'Task not found', data: {} });
    }
    if (err instanceof SyntaxError || err?.code === 'BAD_JSON') {
      return res.status(400).json({ message: 'Invalid select JSON', data: {} });
    }
    return res.status(500).json({ message: 'Server error', data: {} });
  }
});

/** PUT /api/tasks/:id - WITH TRANSACTION (overwrite semantics)
 *  Required: name, deadline, completed, assignedUser.
 *  Sync rules:
 *   - If assignee changes -> pull from old user's pendingTasks.
 *   - If completed=true -> pull from new assignee's pendingTasks.
 *   - If completed=false and assignee set -> addToSet into new assignee's pendingTasks.
 *  IMPORTANT: We preserve dateCreated even with overwrite: true
 */
router.put('/:id', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const cur = await Task.findById(req.params.id).session(session);
    if (!cur) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Task not found', data: {} });
    }

    const {
      name,
      deadline,
      description = '',
      assignedUser = '',
      assignedUserName, // ignored (we recompute)
      completed
    } = req.body;

    if (!name || !deadline || typeof completed === 'undefined') {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Missing required fields', data: {} });
    }
    const completedBool = toBoolean(completed, false);

    // Determine new assignee & name
    let newAssignee = String(assignedUser || '');
    let newAssigneeName = 'unassigned';
    if (newAssignee) {
      const u = await User.findById(newAssignee).select({ name: 1 }).session(session);
      if (u) newAssigneeName = u.name;
      else newAssignee = '';
    }

    const prevAssignee = cur.assignedUser || '';
    
    // Overwrite the task BUT preserve dateCreated
    const updated = await Task.findByIdAndUpdate(
      req.params.id,
      {
        name,
        description,
        deadline,
        completed: completedBool,
        assignedUser: newAssignee,
        assignedUserName: newAssignee ? newAssigneeName : 'unassigned',
        dateCreated: cur.dateCreated  // ← PRESERVE this field!
      },
      { new: true, overwrite: true, session }
    );

    // Sync with users' pendingTasks

    // If assignee changed, pull from previous user's pendingTasks
    if (prevAssignee && prevAssignee.toString() !== newAssignee) {
      await User.updateOne(
        { _id: prevAssignee },
        { $pull: { pendingTasks: updated._id.toString() } },
        { session }
      );
    }

    if (newAssignee) {
      if (completedBool) {
        // Completed tasks should not appear in pendingTasks
        await User.updateOne(
          { _id: newAssignee },
          { $pull: { pendingTasks: updated._id.toString() } },
          { session }
        );
      } else {
        await User.updateOne(
          { _id: newAssignee },
          { $addToSet: { pendingTasks: updated._id.toString() } },
          { session }
        );
      }
    }

    await session.commitTransaction();
    return res.status(200).json({ message: 'Task updated', data: updated });
  } catch (err) {
    await session.abortTransaction();
    
    if (err && err.name === 'CastError') {
      return res.status(404).json({ message: 'Task not found', data: {} });
    }
    return res.status(500).json({ message: 'Server error', data: {} });
  } finally {
    session.endSession();
  }
});

/** DELETE /api/tasks/:id - WITH TRANSACTION
 *  Sync: remove task id from assignee's pendingTasks if present.
 *  Must return 204 No Content (no body).
 */
router.delete('/:id', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const t = await Task.findById(req.params.id).session(session);
    if (!t) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Task not found', data: {} });
    }

    if (t.assignedUser) {
      await User.updateOne(
        { _id: t.assignedUser },
        { $pull: { pendingTasks: t._id.toString() } },
        { session }
      );
    }
    
    await Task.deleteOne({ _id: t._id }, { session });

    await session.commitTransaction();
    return res.status(204).end();
  } catch (err) {
    await session.abortTransaction();
    
    if (err && err.name === 'CastError') {
      return res.status(404).json({ message: 'Task not found', data: {} });
    }
    return res.status(500).json({ message: 'Server error', data: {} });
  } finally {
    session.endSession();
  }
});

module.exports = router;
