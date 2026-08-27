const { buildLoginStart, clearSession, completeLogin, getSessionUser } = require("../lib/server-auth");

module.exports = async (req, res) => {
  const action = String(req.query.action || "");
  try {
    if (action === "login") {
      const value = await buildLoginStart(req);
      res.setHeader("Set-Cookie", value.cookie);
      return res.redirect(value.url);
    }
    if (action === "callback") {
      const value = await completeLogin(req);
      res.setHeader("Set-Cookie", value.cookies);
      return res.redirect(value.next || "/");
    }
    if (action === "yo") {
      const user = getSessionUser(req);
      return user ? res.status(200).json(user) : res.status(401).json({ error: "No autenticado" });
    }
    if (action === "logout") {
      res.setHeader("Set-Cookie", clearSession());
      return res.redirect("/");
    }
    return res.status(404).json({ error: "Accion no encontrada" });
  } catch (error) {
    return res.status(401).json({ error: error.message || "Error de autenticacion" });
  }
};
