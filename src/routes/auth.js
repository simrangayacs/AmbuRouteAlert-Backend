import {Router} from 'express';
import {pool} from '../config/db.js';
const router = Router();

router.post('/login', async (req, res) => {
  const {userId, password, role} = req.body;
  const [[user]] = await pool.query(
    `SELECT id, user_id, name, role, sector
     FROM users WHERE user_id=? AND password=? AND role=? LIMIT 1`,
    [userId, password, role],
  );

  if (!user) {
    return res.status(401).json({success: false, message: 'Invalid credentials'});
  }

  return res.json({success: true, user});
});

export default router;
