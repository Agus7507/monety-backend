const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body } = require('express-validator');
const { query: db } = require('../config/db');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');

/**
 * POST /api/v1/auth/login
 * Login de usuarios internos (agentes, analistas, admins)
 */
router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const { rows } = await db(
        `SELECT id, nombre, apellidos, email, password_hash, rol
         FROM usuarios_sistema WHERE email=$1 AND activo=TRUE`,
        [email]
      );

      if (!rows.length) {
        return res.status(401).json({ ok: false, message: 'Credenciales incorrectas' });
      }

      const user  = rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ ok: false, message: 'Credenciales incorrectas' });
      }

      // Actualizar último acceso
      await db('UPDATE usuarios_sistema SET ultimo_acceso=NOW() WHERE id=$1', [user.id]);

      const token = jwt.sign(
        { sub: user.id, rol: user.rol },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES || '8h' }
      );

      res.json({
        ok: true,
        token,
        user: {
          id:       user.id,
          nombre:   `${user.nombre} ${user.apellidos}`,
          email:    user.email,
          rol:      user.rol,
        },
      });
    } catch (err) { next(err); }
  }
);

/**
 * GET /api/v1/auth/me
 * Devuelve el perfil del usuario autenticado
 */
router.get('/me', authMiddleware, async (req, res) => {
  res.json({ ok: true, user: req.user });
});

module.exports = router;
