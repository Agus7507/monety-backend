const jwt    = require('jsonwebtoken');
const { query } = require('../config/db');

/**
 * Middleware: verifica que el request lleve un JWT válido.
 * Agrega req.user con { id, email, rol } si es correcto.
 */
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, message: 'Token no proporcionado' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Verificar que el usuario siga activo en BD
    const { rows } = await query(
      'SELECT id, nombre, email, rol FROM usuarios_sistema WHERE id=$1 AND activo=TRUE',
      [payload.sub]
    );
    if (!rows.length) {
      return res.status(401).json({ ok: false, message: 'Usuario inactivo o no encontrado' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, message: 'Token inválido o expirado' });
  }
}

/**
 * Fábrica de middleware de roles.
 * Uso: router.get('/ruta', auth, requireRole('ADMIN', 'ANALISTA'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.rol)) {
      return res.status(403).json({ ok: false, message: 'Acceso denegado para este rol' });
    }
    next();
  };
}

module.exports = { authMiddleware: authMiddleware, requireRole };
