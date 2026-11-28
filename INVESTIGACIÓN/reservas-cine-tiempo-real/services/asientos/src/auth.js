// Valida el JWT (Authorization: Bearer <token>) y deja el usuario en req.usuario.
// El usuario sale del claim `sub` del token, nunca del cuerpo de la petición.
const jwt = require('jsonwebtoken');

function noAutenticado(res) {
  return res.status(401).json({ codigo: 'NO_AUTENTICADO', mensaje: 'Token ausente o inválido.' });
}

module.exports = function auth(req, res, next) {
  const [esquema, token] = (req.headers.authorization || '').split(' ');
  if (esquema !== 'Bearer' || !token) return noAutenticado(res);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.sub) return noAutenticado(res);
    req.usuario = String(payload.sub);
    next();
  } catch {
    noAutenticado(res);
  }
};
