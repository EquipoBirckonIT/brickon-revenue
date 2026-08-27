const { requireUser } = require("../lib/server-auth");

const TABLES = {
  revenue_actions: {
    columns: ["id", "created_at", "accion", "partner", "notas", "hecha", "fecha_marcada", "resultado", "resultado_at"],
    write: {
      insert: ["accion", "partner", "notas", "hecha", "fecha_marcada"],
      update: ["hecha", "fecha_marcada", "resultado", "resultado_at"],
      delete: [],
    },
  },
  proy_grupos: {
    columns: ["grupo", "especialista", "unidades_activas", "total_2026", "notas", "updated_at"],
    write: { update: ["total_2026", "updated_at"] },
  },
  proy_mensual: {
    columns: ["id", "grupo", "anio", "mes", "revenue_mensual", "noches_disponibles", "adr", "occ_pct", "noches_reservadas"],
    write: {},
  },
  proy_consejo_historial: {
    columns: ["id", "mes", "monto", "editado_por", "created_at"],
    write: { insert: ["mes", "monto", "editado_por"] },
  },
  proy_ajustes: {
    columns: ["id", "grupo", "meses_afectados", "adr_objetivo", "occ_objetivo", "total_objetivo", "total_anterior", "responsable", "motivo", "created_at"],
    write: { insert: ["grupo", "meses_afectados", "adr_objetivo", "occ_objetivo", "total_objetivo", "total_anterior", "responsable", "motivo"] },
  },
  real_mensual: {
    columns: ["id", "grupo", "anio", "mes"],
    write: {},
  },
  listings: {
    columns: ["id", "grupo", "active", "cuenta_revenue"],
    write: {},
  },
  kickoff_units: {
    columns: ["id", "codigo", "grupo", "tipo", "fecha_kickoff", "pm_by", "rev_by", "activo", "nota_actual", "nota_actual_at", "created_at"],
    write: {
      insert: ["codigo", "grupo", "tipo", "fecha_kickoff", "pm_by", "rev_by"],
      update: ["activo", "nota_actual", "nota_actual_at"],
    },
  },
  kickoff_checkins: {
    columns: ["id", "unit_id", "semana_num", "estado", "reservas_lw", "reservas_hoy", "comentario", "created_at"],
    write: {
      insert: ["unit_id", "semana_num", "estado", "reservas_lw", "reservas_hoy", "comentario"],
      upsert: ["unit_id", "semana_num", "estado"],
    },
  },
};

function env(name) {
  if (!process.env[name]) throw new Error(`Falta la variable de entorno ${name}.`);
  return process.env[name];
}

function body(req) {
  if (!req.body) return {};
  return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
}

function tableConfig(name) {
  const config = TABLES[name];
  if (!config) throw new Error("Tabla no permitida.");
  return config;
}

function stringValue(value, maxLength = 1000) {
  if (typeof value !== "string" || !value || value.length > maxLength) throw new Error("Filtro no valido.");
  return value;
}

function selectValue(config, value) {
  if (value === "*") return value;
  const fields = stringValue(value, 1000).split(",").map((field) => field.trim()).filter(Boolean);
  if (!fields.every((field) => config.columns.includes(field))) throw new Error("Columnas no permitidas.");
  return fields.join(",");
}

function addFilters(url, config, filters) {
  if (!Array.isArray(filters) || filters.length > 8) throw new Error("Filtros no validos.");
  for (const filter of filters) {
    if (!filter || !config.columns.includes(filter.column)) throw new Error("Filtro no permitido.");
    if (filter.operator === "eq") {
      const value = typeof filter.value === "number" || typeof filter.value === "boolean" ? String(filter.value) : stringValue(filter.value);
      url.searchParams.set(filter.column, `eq.${value}`);
      continue;
    }
    if (filter.operator === "in" && Array.isArray(filter.value) && filter.value.length > 0 && filter.value.length <= 50) {
      const values = filter.value.map((item) => {
        if (typeof item !== "number" && typeof item !== "boolean") stringValue(item);
        return String(item);
      });
      url.searchParams.set(filter.column, `in.(${values.join(",")})`);
      continue;
    }
    throw new Error("Operador no permitido.");
  }
}

function checkedPayload(config, operation, input) {
  const allowed = config.write[operation];
  if (!allowed || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("Operacion no permitida.");
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key)) throw new Error("Campo no permitido.");
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("Valor no valido.");
    if (typeof value === "string" && value.length > 5000) throw new Error("Valor demasiado largo.");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Numero no valido.");
    output[key] = value;
  }
  if (!Object.keys(output).length) throw new Error("No hay datos para guardar.");
  return output;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const protocol = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
  return origin === `${protocol}://${host}`;
}

function supabaseUrl(table) {
  return new URL(`${env("REVENUE_SUPABASE_URL").replace(/\/+$/, "")}/rest/v1/${table}`);
}

async function execute(input) {
  const operation = stringValue(input.operation, 20);
  const config = tableConfig(stringValue(input.table, 80));
  const url = supabaseUrl(input.table);
  const filters = input.filters || [];

  if (operation === "select") {
    url.searchParams.set("select", selectValue(config, input.select || "*"));
    addFilters(url, config, filters);
    if (input.order) {
      if (!config.columns.includes(input.order.column)) throw new Error("Orden no permitido.");
      url.searchParams.set("order", `${input.order.column}.${input.order.ascending === false ? "desc" : "asc"}`);
    }
    if (input.limit !== undefined) {
      const limit = Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Limite no valido.");
      url.searchParams.set("limit", String(limit));
    }
    return request(url, "GET");
  }

  if (operation === "delete") {
    if (!config.write.delete || filters.length === 0) throw new Error("La operacion requiere un filtro.");
    addFilters(url, config, filters);
    return request(url, "DELETE", undefined, "return=representation");
  }

  const payload = checkedPayload(config, operation, input.payload);
  if (operation === "update" && filters.length === 0) throw new Error("La operacion requiere un filtro.");
  addFilters(url, config, filters);

  if (operation === "upsert") {
    if (input.table !== "kickoff_checkins" || input.onConflict !== "unit_id,semana_num") throw new Error("Conflicto no permitido.");
    url.searchParams.set("on_conflict", input.onConflict);
    return request(url, "POST", payload, "resolution=merge-duplicates,return=representation");
  }
  if (operation === "insert") return request(url, "POST", payload, "return=representation");
  if (operation === "update") return request(url, "PATCH", payload, "return=representation");
  throw new Error("Operacion no permitida.");
}

async function request(url, method, payload, prefer) {
  const key = env("REVENUE_SUPABASE_SERVICE_KEY");
  const response = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) throw new Error(`Supabase rechazo la operacion (${response.status}).`);
  return data;
}

module.exports = async (req, res) => {
  if (!requireUser(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Metodo no permitido" });
  if (!sameOrigin(req)) return res.status(403).json({ error: "Origen no permitido" });

  try {
    return res.status(200).json({ data: await execute(body(req)) });
  } catch (error) {
    console.error("Revenue API request failed:", error.message || error);
    return res.status(400).json({ error: error.message || "No se pudo completar la operacion." });
  }
};
