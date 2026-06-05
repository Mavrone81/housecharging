import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// Branding for the sign-in screen (no auth required).
router.get('/branding', async (_req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT community_name, address, logo FROM settings WHERE id=1');
    const s = rows[0] || {};
    res.json({
      communityName: s.community_name || 'MCTS',
      address: s.address || '',
      logo: s.logo || null,
    });
  } catch (e) { next(e); }
});

export default router;
