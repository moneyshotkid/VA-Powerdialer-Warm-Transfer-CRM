function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function canAccessCall(req, callLog) {
  if (!callLog || !req.session) return false;
  if (req.session.role === 'admin') return true;
  return Number(callLog.agent_id) === Number(req.session.userId);
}

// Agents may dial a lead only after the queue has claimed it for them. Admins can dial
// any lead (the admin panel and the agent screen share this check).
function canDialLead(req, lead) {
  if (!lead || !req.session) return false;
  if (req.session.role === 'admin') return true;
  return Number(lead.assigned_agent_id) === Number(req.session.userId);
}

module.exports = { requireAuth, requireAdmin, canAccessCall, canDialLead };
