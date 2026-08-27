const crypto = require("crypto");
const { ConfidentialClientApplication } = require("@azure/msal-node");

const SESSION_COOKIE = "brickon_revenue_session";
const FLOW_COOKIE = "brickon_revenue_login";
const DEFAULT_ROLE = "ROL_GENERAL";
const SCOPES = ["openid", "profile", "email", "User.Read"];

function env(name) {
  if (!process.env[name]) throw new Error(`Falta la variable de entorno ${name}.`);
  return process.env[name];
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => part.trim().split(/=(.*)/s)).filter(([name]) => name));
}

function sign(body) {
  return crypto.createHmac("sha256", env("SESSION_SECRET_KEY")).update(body).digest("base64url");
}

function encode(data) {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(value) {
  const [body, signature] = String(value || "").split(".");
  if (!body || !signature || signature.length !== sign(body).length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(body)))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function makeCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; SameSite=Lax; HttpOnly; Secure; Max-Age=${maxAge}`;
}

function baseUrl(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
  return `${protocol}://${host}`;
}

function safeNext(value) {
  return typeof value === "string" && value.startsWith("/") ? value : "/";
}

function client() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: env("MS_CLIENT_ID"),
      clientSecret: env("MS_CLIENT_SECRET"),
      authority: `https://login.microsoftonline.com/${env("MS_TENANT_ID")}`,
    },
  });
}

async function profile(email) {
  const key = env("AUTH_SUPABASE_SERVICE_KEY");
  const url = new URL(`${env("AUTH_SUPABASE_URL").replace(/\/+$/, "")}/rest/v1/perfiles_usuarios`);
  url.searchParams.set("select", "rol,nombre");
  url.searchParams.set("email", `ilike.${email}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) {
    // Microsoft Entra is the authentication boundary. A temporary profile lookup
    // failure must not block a verified corporate user from receiving the safe default role.
    console.error(`No se pudo consultar perfiles_usuarios (${response.status}).`);
    return { nombre: null, rol: DEFAULT_ROLE };
  }
  const item = (await response.json())[0] || {};
  return { nombre: item.nombre || null, rol: String(item.rol || DEFAULT_ROLE).trim().toUpperCase() || DEFAULT_ROLE };
}

async function buildLoginStart(req) {
  const state = crypto.randomBytes(32).toString("hex");
  const nonce = crypto.randomBytes(32).toString("hex");
  const redirectUri = `${baseUrl(req)}/api/auth?action=callback`;
  const url = await client().getAuthCodeUrl({ scopes: SCOPES, redirectUri, state, nonce, prompt: "select_account" });
  return { url, cookie: makeCookie(FLOW_COOKIE, encode({ state, nonce, redirectUri, next: safeNext(req.query.next), exp: Date.now() + 600000 }), 600) };
}

async function completeLogin(req) {
  const flow = decode(parseCookies(req.headers.cookie)[FLOW_COOKIE]);
  if (!flow || !req.query.code || req.query.state !== flow.state) throw new Error("La sesion de inicio ha caducado. Vuelve a intentarlo.");

  const result = await client().acquireTokenByCode({ code: String(req.query.code), scopes: SCOPES, redirectUri: flow.redirectUri });
  const claims = result.idTokenClaims || {};
  const tenant = env("MS_TENANT_ID");
  const email = String(claims.preferred_username || claims.email || claims.upn || "").trim().toLowerCase();
  if (!email || claims.tid !== tenant || (flow.nonce && claims.nonce && flow.nonce !== claims.nonce)) throw new Error("No se pudo validar la cuenta corporativa.");

  const data = await profile(email);
  const user = { correo: email, nombre: data.nombre, rol: data.rol, tid: tenant };
  return { next: flow.next, cookies: [makeCookie(SESSION_COOKIE, encode({ ...user, exp: Date.now() + 28800000 }), 28800), makeCookie(FLOW_COOKIE, "", 0)] };
}

function getSessionUser(req) {
  const data = decode(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  return data ? { correo: data.correo, nombre: data.nombre || null, rol: data.rol || DEFAULT_ROLE, tid: data.tid } : null;
}

function requireUser(req, res) {
  const user = getSessionUser(req);
  if (user) return user;
  res.status(401).json({ error: "No autenticado" });
  return null;
}

function clearSession() {
  return [makeCookie(SESSION_COOKIE, "", 0), makeCookie(FLOW_COOKIE, "", 0)];
}

module.exports = { buildLoginStart, clearSession, completeLogin, getSessionUser, requireUser };
